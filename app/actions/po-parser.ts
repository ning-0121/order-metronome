'use server';

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase/server';

/** 上传文件最大字节数：10MB。超过后拒绝读入内存。 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
/** 草稿恢复时间窗：超过此分钟数视为陈旧不展示。 */
const DRAFT_FRESH_MINUTES = 30;

export type GarmentCategory = 'pants' | 'tops' | 'dress' | 'outerwear' | 'other';

export interface POStyleData {
  style_no: string;
  product_name: string;
  material: string;
  fabric_weight: string;
  total_qty: number;
  colors: {
    color_cn: string;
    color_en: string;
    qty: number;
    sizes: Record<string, number>;
    /** 每色独立的客户包装说明（如"一套一个小包袋，6套一中包"），可选 */
    packaging?: string;
  }[];
  packaging: string;
  quality_notes: string;
  sample_requirements: string;
  /** 单件用量 — 上印 "款式评语" 上方的黄色行，如 "280克直贡呢 1.2平方 0.346公斤" */
  unit_consumption?: string;
  measurements?: {
    label: string;
    values: Record<string, string>;
  }[];
}

export interface POParsedData {
  order_no: string;
  customer_name: string;
  delivery_date: string;
  order_date: string;
  garment_category?: GarmentCategory;
  styles: POStyleData[];
  trims: {
    name: string;
    position: string;
    notes: string;
  }[];
  size_labels: string[];
  confidence_notes: string[];
  /** 生产单右上「注意」框文字（业务员可编辑）。
   * 默认："注意：大货数量不能少出，也不能多出。交货期不能晚，延期会扣款。大货尺寸千万不能做小。" */
  warning_notes?: string;
}

const SYSTEM_PROMPT = `你是一个外贸服装订单解析专家。你的任务是从客户PO（采购订单）中提取信息，返回标准化的JSON格式。

要求：
0. PO 可能是中文或英文,不同客户版式差异很大(表格式/清单式/邮件正文式都有)。常见英文字段名对照:
   Style#/Style No/Item → 款号;Description/Item Name → 品名;Color/Colour/Colorway → 颜色;
   Qty/Quantity/Units → 数量;Size Breakdown/Size Ratio/尺码横排表头 → 尺码配比;
   Delivery Date/Ship Date/Cancel Date → 交期;PO#/Order No → PO号;Fabric/Material/Composition → 面料。
   识别不到的字段留空并写进 confidence_notes,不要猜。
1. 仔细识别每个款式/SKU的颜色、尺码配比、数量
2. 尺码标签可能是 S/M/L/XL 或 2/4/6/8 或其他，请如实提取
3. 如果PO是英文，颜色名请同时提供中文翻译和英文原文
4. 如果某些字段在PO中找不到，填空字符串或0，并在confidence_notes中说明
5. packaging、quality_notes、sample_requirements等信息如果PO中没有，留空即可
6. 数量必须是数字，不要带单位
7. 判断服装品类（pants/tops/dress/outerwear/other）
8. 如果PO中包含尺寸表/测量数据（如腰围、臀围、胸围等各尺码的数值），请提取到measurements数组中
9. 单件用量（unit_consumption）：如果PO提到"单耗"、"用量"、"每件"加面料数据（如"1.2平方"、"0.346公斤"），合并成一个字符串返回，例如 "280克直贡呢 1.2平方 0.346公斤"；找不到就留空
10. 每色客户包装（colors[].packaging）：如果PO对不同颜色有不同包装要求（如黑色"一套一袋"、深红"S:M:L=1:2:2"），分别提取到对应 color 的 packaging 字段

日期解析规则（重要！）：
- Excel的日期序列号（如46124）= 从1900-01-01起的天数，请转换为 YYYY.MM.DD
- 美式日期 MM/DD/YYYY 转为 YYYY.MM.DD
- 英式日期 DD/MM/YYYY 转为 YYYY.MM.DD（如果月份>12则按此格式）
- "Jan 15, 2026" 转为 "2026.01.15"
- 如不确定格式，在 confidence_notes 中注明

价格提取（重要！）：
- unit_price: 单价（数字），必须提取
- currency: 货币（USD/EUR/GBP/RMB等）
- total_amount: 总金额（如有）
- incoterm: 贸易条款（FOB/DDP/CIF等，如PO中注明）
- payment_terms: 付款条款（如T/T 30% deposit, 70% before shipment）

返回严格的JSON格式（不要markdown代码块包裹）：
{
  "order_no": "客户PO号",
  "customer_name": "客户名称",
  "delivery_date": "交期 YYYY.MM.DD",
  "order_date": "下单日期 YYYY.MM.DD",
  "garment_category": "pants",
  "styles": [
    {
      "style_no": "款号",
      "product_name": "品名（中文）",
      "material": "原料成分（如88%涤纶，12%氨纶）",
      "fabric_weight": "面料克重（如280克仿锦）",
      "total_qty": 5130,
      "colors": [
        {
          "color_cn": "黑色",
          "color_en": "BLACK",
          "qty": 2010,
          "sizes": { "S": 670, "M": 670, "L": 670 }
        }
      ],
      "packaging": "包装要求描述",
      "quality_notes": "质量要求/工艺备注",
      "sample_requirements": "产前样/船样要求",
      "measurements": [
        { "label": "腰围", "values": { "S": "12.5", "M": "13.5", "L": "14.5", "XL": "15.5" } },
        { "label": "臀围", "values": { "S": "17.5", "M": "18.5", "L": "19.5", "XL": "20.5" } }
      ]
    }
  ],
  "trims": [
    { "name": "辅料名", "position": "位置说明", "notes": "备注" }
  ],
  "size_labels": ["S", "M", "L"],
  "unit_price": 5.80,
  "currency": "USD",
  "total_amount": 29754.00,
  "incoterm": "FOB",
  "payment_terms": "T/T 30% deposit, 70% before shipment",
  "confidence_notes": ["PO中未找到面料克重信息", "交期日期可能需要确认"]
}`;

export async function parsePO(
  formData: FormData,
  orderId?: string,
): Promise<{ ok: boolean; data?: POParsedData; error?: string; draftId?: string }> {
  // 鉴权 + 配额：之前直接调 Anthropic，任何拿到 server action 端点的人都能刷
  // API 配额（按 Sonnet 4 价格一次几毛钱，一天可烧几百）
  const { guardAICall, logAICall } = await import('@/lib/ai/rate-limit');
  const guard = await guardAICall('po_parse', orderId);
  if (!guard.ok) return { ok: false, error: guard.error };

  const file = formData.get('file') as File | null;
  if (!file) return { ok: false, error: '请上传文件' };

  // P0-3: 文件大小限制 —— 避免大文件 OOM + AI token 爆炸
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `文件 ${mb}MB 超出 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB 上限。请压缩后重传，或拍图上传。`,
    };
  }

  // 省 token(2026-07-03):同名同大小文件 30 分钟内已解析过 → 直接复用冻结草稿,零 AI 调用。
  // 覆盖:上传后重试、误操作二次上传、建单失败后重传同一 PO。
  try {
    const supabaseCache = await createClient();
    const { data: { user: cacheUser } } = await supabaseCache.auth.getUser();
    if (cacheUser) {
      const cutoff = new Date(Date.now() - DRAFT_FRESH_MINUTES * 60 * 1000).toISOString();
      const { data: cached } = await (supabaseCache.from('po_parse_drafts') as any)
        .select('id, parsed_json')
        .eq('user_id', cacheUser.id)
        .eq('file_name', file.name)
        .eq('file_size_bytes', file.size)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle();
      if (cached?.parsed_json) {
        console.log('[parsePO] 命中冻结草稿,跳过 AI 调用(零token):', file.name);
        return { ok: true, data: cached.parsed_json as POParsedData, draftId: cached.id };
      }
    }
  } catch { /* 缓存查询失败不阻断,继续走 AI */ }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'AI 服务未配置，请联系管理员' };

  const startedAt = Date.now();
  try {
    const client = new Anthropic({ apiKey });
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileType = file.type;
    const fileName = file.name.toLowerCase();

    let messages: Anthropic.MessageParam[];

    if (fileType.startsWith('image/') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png')) {
      // Image: use vision
      const base64 = buffer.toString('base64');
      const mediaType = fileType.startsWith('image/') ? fileType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' : 'image/jpeg';
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: '请解析这个客户PO图片，提取订单信息。' }
        ]
      }];
    } else if (fileName.endsWith('.pdf')) {
      // PDF: use document support
      const base64 = buffer.toString('base64');
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: '请解析这个客户PO文件，提取订单信息。' }
        ]
      }];
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv')) {
      // Excel: convert to text representation
      const textContent = await excelToText(buffer, fileName);
      messages = [{
        role: 'user',
        content: `请解析以下客户PO内容，提取订单信息：\n\n${textContent}`
      }];
    } else {
      return { ok: false, error: `不支持的文件格式：${file.type}。请上传 Excel、PDF 或图片文件。` };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000); // 55 秒超时

    let response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-5',            // 2026-07-03:老 sonnet-4-6 慢 → 最新最快的 Sonnet,提取更准
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
      }, { signal: controller.signal });     // 关键修复:此前 signal 没传给 SDK → 55秒超时形同虚设,请求会一直挂到 SDK 默认 10 分钟
      // 注:不设 thinking,与小绮/原辅料识别等已验证能跑的 sonnet-5 调用对齐(避免个别参数触发 API 报错→静默失败)
    } catch (e: any) {
      if (e.name === 'AbortError' || e.message?.includes('abort')) {
        return { ok: false, error: 'AI 解析超时,请尝试上传更小的文件或使用图片格式。' };
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as Anthropic.TextBlock).text)
      .join('');

    // Parse JSON from response (handle potential markdown wrapping)
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // P1-4: JSON.parse 单独 try/catch — 否则 Claude 偶尔返回带前导文字的 JSON
    // 整体被吞进 catch-all，用户看到的是莫名其妙的 "Unexpected token"
    let parsed: POParsedData;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      const snippet = jsonStr.slice(0, 300);
      console.error('[parsePO] JSON parse failed, raw:', snippet);
      logAICall('po_parse', orderId || null, 'error', Date.now() - startedAt,
        `JSON parse failed: ${snippet}`).catch(() => {});
      return {
        ok: false,
        error: 'AI 返回格式异常，已记录。请重试或换张更清晰的图片/PDF。',
      };
    }

    logAICall('po_parse', orderId || null, 'success', Date.now() - startedAt).catch(() => {});

    // P0-1: 解析成功后落库，防关闭/刷新丢数据
    const draftId = await savePOParseDraft(orderId, file.name, file.size, parsed).catch((e) => {
      console.warn('[parsePO] save draft failed (non-blocking):', e?.message);
      return undefined;
    });

    return { ok: true, data: parsed, draftId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[parsePO] Error:', message);
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || message.includes('abort'));
    logAICall('po_parse', orderId || null, isTimeout ? 'timeout' : 'error', Date.now() - startedAt, message.slice(0, 200)).catch(() => {});
    if (message.includes('credit balance') || message.includes('billing')) {
      return { ok: false, error: 'AI 服务余额不足，请联系管理员充值 Anthropic API 额度。' };
    }
    return { ok: false, error: `解析失败：${message}` };
  }
}

// ──────────────────────────────────────────────────────────
// P0-1: 草稿持久化（po_parse_drafts 表）
// ──────────────────────────────────────────────────────────

/**
 * 内部辅助：把解析结果存入草稿表。返回 draftId。
 * RLS 已保证 user_id 必须 = auth.uid()，service-role 不在此用，走 user session。
 */
async function savePOParseDraft(
  orderId: string | undefined,
  fileName: string,
  fileSize: number,
  parsedJson: POParsedData,
): Promise<string | undefined> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return undefined;
  const { data, error } = await (supabase.from('po_parse_drafts') as any)
    .insert({
      user_id: user.id,
      order_id: orderId || null,
      file_name: fileName,
      file_size_bytes: fileSize,
      parsed_json: parsedJson,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[savePOParseDraft] insert failed:', error.message);
    return undefined;
  }
  return data?.id;
}

/**
 * Server Action：取当前用户在此订单上最近 30 分钟内的草稿（最新一条）。
 * 用于 Modal 打开时检测"是否有未完成的解析草稿"。
 */
export async function getRecentPOParseDraft(orderId: string): Promise<{
  ok: boolean;
  draft?: {
    id: string;
    parsed_json: POParsedData;
    file_name: string | null;
    age_minutes: number;
  };
  error?: string;
}> {
  if (!orderId) return { ok: false, error: 'orderId 不能为空' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '未登录' };

  const cutoff = new Date(Date.now() - DRAFT_FRESH_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await (supabase.from('po_parse_drafts') as any)
    .select('id, parsed_json, file_name, updated_at')
    .eq('user_id', user.id)
    .eq('order_id', orderId)
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[getRecentPOParseDraft] query failed:', error.message);
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: true };

  const ageMs = Date.now() - new Date(data.updated_at).getTime();
  return {
    ok: true,
    draft: {
      id: data.id,
      parsed_json: data.parsed_json,
      file_name: data.file_name,
      age_minutes: Math.round(ageMs / 60000),
    },
  };
}

/**
 * Server Action：用户在 preview 中编辑后关闭 Modal 时调用，把当前状态盖回草稿。
 */
export async function updatePOParseDraft(
  draftId: string,
  parsedJson: POParsedData,
): Promise<{ ok: boolean; error?: string }> {
  if (!draftId) return { ok: false, error: 'draftId 不能为空' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '未登录' };

  const { error } = await (supabase.from('po_parse_drafts') as any)
    .update({ parsed_json: parsedJson, updated_at: new Date().toISOString() })
    .eq('id', draftId)
    .eq('user_id', user.id); // RLS 已保护，这里双保险
  if (error) {
    console.warn('[updatePOParseDraft] update failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Server Action：生成 Excel 成功 / 用户主动丢弃草稿时调用。
 */
export async function deletePOParseDraft(draftId: string): Promise<{ ok: boolean }> {
  if (!draftId) return { ok: false };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  await (supabase.from('po_parse_drafts') as any)
    .delete()
    .eq('id', draftId)
    .eq('user_id', user.id);
  return { ok: true };
}

async function excelToText(buffer: Buffer, fileName: string): Promise<string> {
  // Use exceljs to read Excel and convert to text
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();

  if (fileName.endsWith('.csv')) {
    const csvContent = buffer.toString('utf-8');
    return csvContent;
  }

  await workbook.xlsx.load(buffer);

  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`\n=== Sheet: ${sheet.name} ===`);
    sheet.eachRow((row, rowNumber) => {
      const values = (row.values as (string | number | null)[]).slice(1); // skip index 0
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
