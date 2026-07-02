'use server';

/**
 * 原辅料单批量识别 —— 上传文件(Excel/PDF/图片) → AI 读出结构化 BOM 行 → 预填给业务检查后入库。
 * 套 parsePO 的成熟模式(文件三态处理 + 限速 + JSON 解析容错)。只解析不落库,落库走 addBomItemsBatch。
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase/server';
import { guardAICall, logAICall } from '@/lib/ai/rate-limit';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface ParsedBomItem {
  material_name: string;
  material_type: string;   // fabric/trim/lining/label/packing/print/washing/embroidery/service/other
  color?: string;
  spec?: string;
  qty_per_piece?: number | null;
  unit?: string;
  supplier?: string;
  placement?: string;
  special_requirements?: string;
  notes?: string;
}

const SYSTEM_PROMPT = `你是外贸服装厂的原辅料单解析专家。从上传的原辅料单/辅料表/物料清单中提取每一行物料,返回 JSON。

要求:
1. material_type 只能取: fabric(面料)/trim(辅料)/lining(里料)/label(标签,含吊牌烫标贴纸)/packing(包装,含胶袋纸箱)/print(印花)/washing(水洗)/embroidery(绣花)/service(服务)/other
2. qty_per_piece = 单件用量(数字;写"一件用一个/一套/一张"就是 1;没写留 null)
3. unit = 用量单位(kg/米/个/套/张/码 等;和 qty_per_piece 对应)
4. placement = 使用位置(如"左侧外侧缝腰缝处");special_requirements = 工艺/操作要求(如"5cm透明枪针,不能打到面料上")
5. 布料的克重/成分写进 spec;颜色写 color
6. 识别不确定的地方写进 confidence_notes
7. 只输出 JSON,不要多余文字

输出格式:
{
  "items": [
    { "material_name": "280克防水仿锦拉毛布", "material_type": "fabric", "color": "黑色", "spec": "280克", "qty_per_piece": 0.346, "unit": "kg", "supplier": "", "placement": "大身", "special_requirements": "", "notes": "" }
  ],
  "confidence_notes": ["纸箱装箱数未写明,留空"]
}`;

export async function parseBomFile(formData: FormData): Promise<{
  ok: boolean; data?: { items: ParsedBomItem[]; confidence_notes: string[] }; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };

  const guard = await guardAICall('bom_parse');
  if (!guard.ok) return { ok: false, error: guard.error };

  const file = formData.get('file') as File | null;
  if (!file || file.size === 0) return { ok: false, error: '请选择文件' };
  if (file.size > MAX_FILE_SIZE_BYTES) return { ok: false, error: '文件超过 10MB,请压缩后再传' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'AI 服务未配置,请联系管理员' };

  const startedAt = Date.now();
  try {
    const client = new Anthropic({ apiKey });
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileType = file.type;
    const fileName = file.name.toLowerCase();

    let messages: Anthropic.MessageParam[];
    if (fileType.startsWith('image/') || /\.(jpg|jpeg|png)$/.test(fileName)) {
      const base64 = buffer.toString('base64');
      const mediaType = fileType.startsWith('image/') ? fileType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' : 'image/jpeg';
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: '请解析这张原辅料单图片,提取每行物料。' },
        ],
      }];
    } else if (fileName.endsWith('.pdf')) {
      const base64 = buffer.toString('base64');
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: '请解析这个原辅料单文件,提取每行物料。' },
        ],
      }];
    } else if (/\.(xlsx|xls|csv)$/.test(fileName)) {
      const textContent = await excelToText(buffer, fileName);
      messages = [{ role: 'user', content: `请解析以下原辅料单内容,提取每行物料:\n\n${textContent}` }];
    } else {
      return { ok: false, error: `不支持的文件格式:${file.type}。请上传 Excel、PDF 或图片。` };
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as Anthropic.TextBlock).text)
      .join('');

    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    let parsed: { items?: ParsedBomItem[]; confidence_notes?: string[] };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      logAICall('bom_parse', null, 'error', Date.now() - startedAt, 'JSON parse failed').catch(() => {});
      return { ok: false, error: 'AI 返回格式异常,请重试或换个更清晰的文件' };
    }

    const items = (parsed.items || []).filter(i => i?.material_name?.trim());
    if (items.length === 0) return { ok: false, error: '没有识别到物料行,请确认文件内容' };

    logAICall('bom_parse', null, 'success', Date.now() - startedAt).catch(() => {});
    return { ok: true, data: { items, confidence_notes: parsed.confidence_notes || [] } };
  } catch (err: any) {
    console.error('[parseBomFile]', err?.message);
    logAICall('bom_parse', null, 'error', Date.now() - startedAt, err?.message?.slice(0, 200)).catch(() => {});
    return { ok: false, error: '解析失败:' + (err?.message || '请稍后重试') };
  }
}

async function excelToText(buffer: Buffer, fileName: string): Promise<string> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  if (fileName.endsWith('.csv')) return buffer.toString('utf-8');
  await workbook.xlsx.load(buffer as any);
  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`\n=== Sheet: ${sheet.name} ===`);
    sheet.eachRow((row, rowNumber) => {
      const values = (row.values as (string | number | null)[]).slice(1);
      const cells = values.map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && 'text' in v) return (v as { text: string }).text;
        if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result);
        return String(v);
      });
      lines.push(`Row ${rowNumber}: ${cells.join(' | ')}`);
    });
  });
  return lines.join('\n');
}
