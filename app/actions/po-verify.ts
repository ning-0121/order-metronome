'use server';

import { qimoAI, AIRuntimeError, type FileInput, type ImageInput, type SchemaValidator } from '@/lib/ai/runtime';

export interface POVerifyResult {
  document_type?: 'customer_po' | 'quotation' | 'invoice' | 'packing_list' | 'tech_pack' | 'sample_card' | 'other' | 'unknown';
  confidence?: number;
  document_type_warning?: string;
  po_quantity?: number;
  po_delivery_date?: string;
  po_customer?: string;
  po_style_no?: string;
  po_po_number?: string;
  differences: { field: string; fieldLabel: string; poValue: string; orderValue: string; severity: 'error' | 'warning' }[];
  risks: { type: string; label: string; detail: string; severity: 'high' | 'medium' }[];
  matched: string[];
  special_terms: string[];
  raw_extracted: Record<string, string>;
}

export interface ThreeDocVerifyResult {
  summary: string;
  differences: { field: string; internalValue: string; customerQuoteValue: string; poValue: string; severity: 'error' | 'warning'; note: string }[];
  risks: string[];
  allMatch: boolean;
  priceMatch: boolean;
  priceDiffs: { field: string; internalValue: string; customerQuoteValue: string; poValue: string; note: string }[];
}

type DocumentType = NonNullable<POVerifyResult['document_type']>;
interface ExtractedDocument {
  document_type: DocumentType;
  confidence: number;
  document_type_warning: string;
  quantity: number;
  delivery_date: string;
  customer_name: string;
  style_no: string;
  po_number: string;
  order_date: string;
  unit_price: string;
  currency: string;
  color: string;
  size_ratio: string;
  packing: string;
  craft_requirements: string;
  risks: { type: string; label: string; detail: string }[];
  special_terms: string[];
}

const stringField = { type: 'string' } as const;
const extractedDocumentSchema: SchemaValidator<ExtractedDocument> = {
  name: 'qimo_po_verification_extract_v1', strict: true,
  jsonSchema: {
    type: 'object', additionalProperties: false,
    required: ['document_type', 'confidence', 'document_type_warning', 'quantity', 'delivery_date', 'customer_name', 'style_no', 'po_number', 'order_date', 'unit_price', 'currency', 'color', 'size_ratio', 'packing', 'craft_requirements', 'risks', 'special_terms'],
    properties: {
      document_type: { type: 'string', enum: ['customer_po', 'quotation', 'invoice', 'packing_list', 'tech_pack', 'sample_card', 'other', 'unknown'] },
      confidence: { type: 'number' }, quantity: { type: 'number' },
      document_type_warning: stringField, delivery_date: stringField, customer_name: stringField,
      style_no: stringField, po_number: stringField, order_date: stringField, unit_price: stringField,
      currency: stringField, color: stringField, size_ratio: stringField, packing: stringField, craft_requirements: stringField,
      risks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'label', 'detail'], properties: { type: stringField, label: stringField, detail: stringField } } },
      special_terms: { type: 'array', items: stringField },
    },
  },
  parse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO verification result must be an object' });
    const row = value as Record<string, unknown>;
    const strings = ['document_type_warning', 'delivery_date', 'customer_name', 'style_no', 'po_number', 'order_date', 'unit_price', 'currency', 'color', 'size_ratio', 'packing', 'craft_requirements'];
    if (!['customer_po', 'quotation', 'invoice', 'packing_list', 'tech_pack', 'sample_card', 'other', 'unknown'].includes(String(row.document_type))
      || typeof row.confidence !== 'number' || typeof row.quantity !== 'number'
      || strings.some(field => typeof row[field] !== 'string') || !Array.isArray(row.risks) || !Array.isArray(row.special_terms)) {
      throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO verification result has invalid fields' });
    }
    for (const risk of row.risks) {
      if (!risk || typeof risk !== 'object' || ['type', 'label', 'detail'].some(field => typeof (risk as Record<string, unknown>)[field] !== 'string')) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO risk is invalid' });
    }
    if (row.special_terms.some(term => typeof term !== 'string')) throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'PO special terms are invalid' });
    return row as unknown as ExtractedDocument;
  },
};

const EXTRACT_PROMPT = `识别这份服装外贸单据并提取可核验字段。只依据文件内容，不猜测；找不到的字符串填空字符串，数量填0。
document_type 必须判断为 customer_po/quotation/invoice/packing_list/tech_pack/sample_card/other/unknown。
真正客户PO通常在客户名、PO号、数量、交期中至少有两项。unit_price 保留数值和计价单位原文；currency、颜色、尺码配比、包装、工艺要求原样提取。
risks 只列文件明确支持的浅色、撞色、特殊洗水、紧交期或特殊包装风险；special_terms 保留验货、罚款、测试等条款。`;

async function extractExcelToText(base64: string): Promise<string | null> {
  try {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const parts: string[] = [];
    for (const sheet of workbook.worksheets) {
      const rows: string[] = [];
      sheet.eachRow({ includeEmpty: false }, row => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, cell => {
          const value = cell.value;
          const objectValue = value && typeof value === 'object' ? value as unknown as Record<string, unknown> : undefined;
          const richText = Array.isArray(objectValue?.richText)
            ? objectValue.richText.map(item => item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : '').join('')
            : undefined;
          const text = value == null ? '' : objectValue?.text ?? objectValue?.result ?? richText ?? String(value);
          cells.push(String(text).replace(/\|/g, '\\|').slice(0, 200));
        });
        if (cells.some(cell => cell.trim())) rows.push(`| ${cells.join(' | ')} |`);
      });
      if (rows.length) parts.push(`## Sheet: ${sheet.name}`, rows.slice(0, 200).join('\n'));
    }
    return parts.join('\n');
  } catch (error) {
    console.error('[po-verify] Excel parse error:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

async function extractDocument(fileBase64: string, fileType: string, fileName: string, scene: string): Promise<ExtractedDocument> {
  let image: ImageInput | undefined;
  let file: FileInput | undefined;
  let prompt = EXTRACT_PROMPT;
  if (fileType.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
    const mediaType = (fileType.startsWith('image/') ? fileType : 'image/jpeg') as ImageInput['mediaType'];
    image = { mediaType, base64: fileBase64, detail: 'high' };
  } else if (fileType === 'application/pdf' || /\.pdf$/i.test(fileName)) {
    file = { filename: fileName, mediaType: 'application/pdf', base64: fileBase64 };
  } else if (/\.(xlsx|xls|xlsm)$/i.test(fileName)) {
    const text = await extractExcelToText(fileBase64);
    if (!text) throw new Error('Excel 文件解析失败，请确认文件未损坏');
    prompt = `${EXTRACT_PROMPT}\n\nExcel 内容：\n${text.slice(0, 30000)}`;
  } else {
    throw new Error('暂只支持 PDF / 图片 / Excel 格式');
  }
  const result = await qimoAI.generateObject({
    scene, capability: 'structured-extraction', logicalModel: 'qimo.structured-extraction', riskLevel: 'high',
    prompt, schema: extractedDocumentSchema, image, file, timeoutMs: 45_000, maxOutputTokens: 2048, fallback: 'allowed',
  });
  return result.data;
}

export async function verifyPOAgainstOrder(
  fileBase64: string, fileType: string, fileName: string,
  orderData: { quantity?: number | null; delivery_date?: string | null; customer_name?: string | null; style_no?: string | null; po_number?: string | null; order_no?: string },
): Promise<{ data?: POVerifyResult; error?: string }> {
  try {
    const extracted = await extractDocument(fileBase64, fileType, fileName, 'order.po.verify');
    const differences: POVerifyResult['differences'] = [];
    const matched: string[] = [];
    const typeLabels: Record<string, string> = { quotation: '报价单', invoice: '发票', packing_list: '装箱单', tech_pack: '工艺单/技术包', sample_card: '样品卡', other: '其他文档', unknown: '无法识别' };
    let warning = extracted.document_type_warning || undefined;
    if (extracted.document_type !== 'customer_po') {
      warning ||= `⚠️ AI 判断这不是客户 PO，看起来是「${typeLabels[extracted.document_type] || extracted.document_type}」。请确认上传的文件正确。`;
      differences.push({ field: 'document_type', fieldLabel: '文件类型', poValue: typeLabels[extracted.document_type] || extracted.document_type, orderValue: '客户 PO', severity: 'error' });
    } else if (extracted.confidence < 60) {
      warning = `⚠️ AI 提取置信度较低（${extracted.confidence}/100），请人工核对所有字段。`;
      differences.push({ field: 'confidence', fieldLabel: '提取置信度', poValue: `${extracted.confidence}/100`, orderValue: '≥ 60', severity: 'warning' });
    }
    compareNumber('quantity', '订单数量', extracted.quantity, orderData.quantity, 'error', differences, matched);
    compareText('delivery_date', '交期/ETA', normalizeDate(extracted.delivery_date), normalizeDate(orderData.delivery_date), 'error', differences, matched);
    compareText('customer_name', '客户名称', extracted.customer_name, orderData.customer_name, 'warning', differences, matched, true);
    compareText('po_number', 'PO号', extracted.po_number, orderData.po_number, 'warning', differences, matched);
    return { data: {
      document_type: extracted.document_type, confidence: extracted.confidence, document_type_warning: warning,
      po_quantity: extracted.quantity || undefined, po_delivery_date: extracted.delivery_date || undefined,
      po_customer: extracted.customer_name || undefined, po_style_no: extracted.style_no || undefined, po_po_number: extracted.po_number || undefined,
      differences, matched, special_terms: extracted.special_terms,
      risks: extracted.risks.map(risk => ({ ...risk, severity: ['light_color', 'color_clash', 'tight_deadline'].includes(risk.type) ? 'high' : 'medium' })),
      raw_extracted: extracted as unknown as Record<string, string>,
    } };
  } catch (error) { return { error: `比对失败：${error instanceof Error ? error.message : String(error)}` }; }
}

function normalizeDate(value?: string | null): string { return value ? value.replace(/\./g, '-').slice(0, 10) : ''; }
function compareNumber(field: string, label: string, actual: number, expected: number | null | undefined, severity: 'error' | 'warning', differences: POVerifyResult['differences'], matched: string[]) {
  if (!actual || expected == null) return;
  if (Number(actual) === Number(expected)) matched.push(`${label}一致`);
  else differences.push({ field, fieldLabel: label, poValue: String(actual), orderValue: String(expected), severity });
}
function compareText(field: string, label: string, actual: string, expected: string | null | undefined, severity: 'error' | 'warning', differences: POVerifyResult['differences'], matched: string[], fuzzy = false) {
  if (!actual || !expected) return;
  const left = actual.toLowerCase().trim(); const right = expected.toLowerCase().trim();
  const equal = fuzzy ? left.includes(right) || right.includes(left) : left === right;
  if (equal) matched.push(`${label}一致`); else differences.push({ field, fieldLabel: label, poValue: actual, orderValue: expected, severity });
}

type UploadDocument = { type: 'internal_quote' | 'customer_quote' | 'customer_po'; base64: string; fileType: string; fileName: string };
export async function verifyThreeDocuments(files: UploadDocument[]): Promise<{ data?: ThreeDocVerifyResult; error?: string }> {
  if (files.length < 2) return { error: '至少需要2个文件进行比对' };
  try {
    const extracted = await Promise.all(files.map(async item => ({ type: item.type, data: await extractDocument(item.base64, item.fileType, item.fileName, `order.po.compare.${item.type}`) })));
    return { data: compareExtractedDocuments(extracted) };
  } catch (error) { return { error: `三单比对失败：${error instanceof Error ? error.message : String(error)}` }; }
}

function compareExtractedDocuments(documents: { type: UploadDocument['type']; data: ExtractedDocument }[]): ThreeDocVerifyResult {
  const byType = new Map(documents.map(item => [item.type, item.data]));
  const internal = byType.get('internal_quote'); const quote = byType.get('customer_quote'); const po = byType.get('customer_po');
  const differences: ThreeDocVerifyResult['differences'] = [];
  const priceDiffs: ThreeDocVerifyResult['priceDiffs'] = [];
  const values = (key: keyof ExtractedDocument) => [String(internal?.[key] ?? ''), String(quote?.[key] ?? ''), String(po?.[key] ?? '')];
  const addDifference = (field: string, severity: 'error' | 'warning', note: string) => {
    const [internalValue, customerQuoteValue, poValue] = values(field as keyof ExtractedDocument);
    differences.push({ field, internalValue, customerQuoteValue, poValue, severity, note });
  };
  for (const [field, label] of [['style_no', '款号'], ['quantity', '数量'], ['delivery_date', '交期'], ['color', '颜色'], ['size_ratio', '尺码配比'], ['packing', '包装方式'], ['craft_requirements', '工艺要求']] as const) {
    const present = values(field).filter(Boolean); if (new Set(present).size > 1) addDifference(field, field === 'quantity' || field === 'delivery_date' ? 'error' : 'warning', `${label}不一致`);
  }
  for (const [field, label] of [['unit_price', '单价'], ['currency', '币种']] as const) {
    const all = values(field); const present = all.filter(Boolean);
    if (present.length !== documents.length || new Set(present).size > 1) {
      addDifference(field, 'error', present.length !== documents.length ? `${label}缺失，无法确认三单一致` : `${label}不一致`);
      const last = differences[differences.length - 1];
      priceDiffs.push({ field, internalValue: last.internalValue, customerQuoteValue: last.customerQuoteValue, poValue: last.poValue, note: last.note });
    }
  }
  const risks = documents.flatMap(item => item.data.risks.map(risk => `${item.type}: ${risk.label} ${risk.detail}`));
  return { summary: differences.length ? `发现 ${differences.length} 项差异，请人工复核。` : '单据关键字段一致。', differences, risks, allMatch: differences.length === 0, priceMatch: priceDiffs.length === 0, priceDiffs };
}
