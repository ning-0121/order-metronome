'use server';

import Anthropic from '@anthropic-ai/sdk';

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
  }[];
  packaging: string;
  quality_notes: string;
  sample_requirements: string;
}

export interface POParsedData {
  order_no: string;
  customer_name: string;
  delivery_date: string;
  order_date: string;
  styles: POStyleData[];
  trims: {
    name: string;
    position: string;
    notes: string;
  }[];
  size_labels: string[];
  confidence_notes: string[];
}

const SYSTEM_PROMPT = `你是一个外贸服装订单解析专家。你的任务是从客户PO（采购订单）中提取信息，返回标准化的JSON格式。

要求：
1. 仔细识别每个款式/SKU的颜色、尺码配比、数量
2. 尺码标签可能是 S/M/L/XL 或 2/4/6/8 或其他，请如实提取
3. 如果PO是英文，颜色名请同时提供中文翻译和英文原文
4. 如果某些字段在PO中找不到，填空字符串或0，并在confidence_notes中说明
5. packaging、quality_notes、sample_requirements等信息如果PO中没有，留空即可
6. 数量必须是数字，不要带单位

返回严格的JSON格式（不要markdown代码块包裹）：
{
  "order_no": "客户PO号",
  "customer_name": "客户名称",
  "delivery_date": "交期 YYYY.MM.DD",
  "order_date": "下单日期 YYYY.MM.DD",
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
      "sample_requirements": "产前样/船样要求"
    }
  ],
  "trims": [
    { "name": "辅料名", "position": "位置说明", "notes": "备注" }
  ],
  "size_labels": ["S", "M", "L"],
  "confidence_notes": ["PO中未找到面料克重信息", "交期日期可能需要确认"]
}`;

export async function parsePO(formData: FormData): Promise<{ ok: boolean; data?: POParsedData; error?: string }> {
  const file = formData.get('file') as File | null;
  if (!file) return { ok: false, error: '请上传文件' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'AI 服务未配置，请联系管理员' };

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

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as Anthropic.TextBlock).text)
      .join('');

    // Parse JSON from response (handle potential markdown wrapping)
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed: POParsedData = JSON.parse(jsonStr);
    return { ok: true, data: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[parsePO] Error:', message);
    if (message.includes('credit balance') || message.includes('billing')) {
      return { ok: false, error: 'AI 服务余额不足，请联系管理员充值 Anthropic API 额度。' };
    }
    return { ok: false, error: `解析失败：${message}` };
  }
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
