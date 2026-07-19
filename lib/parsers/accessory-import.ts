import ExcelJS from 'exceljs';

export type AccessoryCandidateValue = {
  accessory_code: string | null; accessory_name: string; specification: string | null;
  color: string | null; usage_position: string | null; unit: string | null;
  unit_consumption: number | null; consumption_basis: string | null; quantity: number | null;
  notes: string | null; special_requirements: string | null; sample_reference: string | null;
  position_description: string | null; image_urls: string[]; attachment_files: string[];
};

export type AccessoryBomRow = {
  id: string;
  material_code?: string | null;
  material_name?: string | null;
  spec?: string | null;
  specification?: string | null;
  color?: string | null;
  placement?: string | null;
  usage_position?: string | null;
  unit?: string | null;
  qty_per_piece?: number | string | null;
  notes?: string | null;
  special_requirements?: string | null;
  sample_reference?: string | null;
  position_description?: string | null;
  image_urls?: string[] | null;
  attachment_files?: string[] | null;
};

const aliases: Record<keyof AccessoryCandidateValue, string[]> = {
  accessory_code: ['辅料编码','物料编码','编码','code'], accessory_name: ['辅料名称','物料名称','名称','name'],
  specification: ['规格','specification','spec'], color: ['颜色','color'],
  usage_position: ['使用部位','位置','部位','usage position','position'], unit: ['单位','unit'],
  unit_consumption: ['单耗','单位用量','unit consumption'], consumption_basis: ['用量基准','计价基准','consumption basis'],
  quantity: ['数量','总需数量','quantity','qty'],
  notes: ['备注','note','notes'], special_requirements: ['特殊要求','special requirement','special requirements'],
  sample_reference: ['样品编号','参考编号','sample reference','reference'], position_description: ['位置说明','位置描述','position description'],
  image_urls: ['图片','示例图','实例图','图片链接','image','image url','image urls'],
  attachment_files: ['画稿','附件','文件附件','attachment','attachments','attachment file','attachment files'],
};
const text = (v: ExcelJS.CellValue) => v == null ? '' : typeof v === 'object' && 'text' in v ? String(v.text).trim() : String(v).trim();
const norm = (v: string) => v.trim().toLowerCase().replace(/[\s\-_（）()]/g, '');
const splitList = (v: string) => v
  .split(/[\n\r,，;；、|]+/g)
  .map((s) => s.trim())
  .filter(Boolean);
const uniq = (values: string[]) => [...new Set(values)];
const toTextArray = (v: string) => uniq(splitList(v));
const toNumber = (s: string) => s !== '' && Number.isFinite(Number(s)) ? Number(s) : null;

export async function parseAccessoryWorkbook(bytes: ArrayBuffer) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
      const headers = Array.from({ length: ws.columnCount }, (_, i) => text(ws.getRow(r).getCell(i + 1).value));
      const map = new Map<keyof AccessoryCandidateValue, number>();
      for (const key of Object.keys(aliases) as Array<keyof AccessoryCandidateValue>) {
        const i = headers.findIndex(h => aliases[key].some(a => norm(h) === norm(a))); if (i >= 0) map.set(key, i + 1);
      }
      if (!map.has('accessory_name')) continue;
      const rows: Array<{ sourceRow: number; raw: Record<string,string>; normalized: AccessoryCandidateValue; missingFields: string[]; fingerprint: string }> = [];
      for (let n = r + 1; n <= ws.rowCount; n++) {
        const get = (k: keyof AccessoryCandidateValue) => map.has(k) ? text(ws.getRow(n).getCell(map.get(k)!).value) : '';
        const name = get('accessory_name'); if (!name) continue;
        const imageCell = get('image_urls');
        const attachmentCell = get('attachment_files');
        const normalized: AccessoryCandidateValue = {
          accessory_code: get('accessory_code') || null, accessory_name: name, specification: get('specification') || null,
          color: get('color') || null, usage_position: get('usage_position') || null, unit: get('unit') || null,
          unit_consumption: toNumber(get('unit_consumption')), consumption_basis: get('consumption_basis') || null, quantity: toNumber(get('quantity')),
          notes: get('notes') || null, special_requirements: get('special_requirements') || null,
          sample_reference: get('sample_reference') || null, position_description: get('position_description') || null,
          image_urls: imageCell ? toTextArray(imageCell) : [], attachment_files: attachmentCell ? toTextArray(attachmentCell) : [],
        };
        const missingFields = (['accessory_name','usage_position','unit','unit_consumption'] as const).filter(k => normalized[k] == null || normalized[k] === '');
        const raw = Object.fromEntries(headers.map((h, i) => [h || `column_${i + 1}`, text(ws.getRow(n).getCell(i + 1).value)]));
        rows.push({ sourceRow: n, raw, normalized, missingFields,
          fingerprint: [normalized.accessory_code, name, normalized.specification, normalized.color, normalized.usage_position].map(x => norm(String(x || ''))).join('|') });
      }
      return { worksheetName: ws.name, rows };
    }
  }
  throw new Error('未找到“辅料名称/物料名称”表头');
}

function normalizeCandidateKey(value: Pick<AccessoryCandidateValue, 'accessory_name' | 'specification' | 'color' | 'usage_position'>) {
  return [value.accessory_name, value.specification, value.color, value.usage_position].map((x) => norm(String(x || ''))).join('|');
}

export function compareAccessoryCandidateToBom(value: AccessoryCandidateValue, bom: AccessoryBomRow) {
  const diffFields: string[] = [];
  if (norm(String(bom.material_code || '')) && norm(String(value.accessory_code || '')) && norm(String(bom.material_code || '')) !== norm(String(value.accessory_code || ''))) diffFields.push('accessory_code');
  if (norm(String(bom.material_name || '')) && norm(String(value.accessory_name || '')) && norm(String(bom.material_name || '')) !== norm(String(value.accessory_name || ''))) diffFields.push('accessory_name');
  if (norm(String(bom.spec || bom.specification || '')) !== norm(String(value.specification || '')) && (bom.spec || bom.specification || value.specification)) diffFields.push('specification');
  if (norm(String(bom.color || '')) !== norm(String(value.color || '')) && (bom.color || value.color)) diffFields.push('color');
  if (norm(String(bom.placement || bom.usage_position || '')) !== norm(String(value.usage_position || '')) && (bom.placement || bom.usage_position || value.usage_position)) diffFields.push('usage_position');
  if (norm(String(bom.unit || '')) !== norm(String(value.unit || '')) && (bom.unit || value.unit)) diffFields.push('unit');
  if (typeof bom.qty_per_piece === 'number' && value.unit_consumption != null && Number(bom.qty_per_piece) !== Number(value.unit_consumption)) diffFields.push('unit_consumption');
  return uniq(diffFields);
}

export function matchAccessory(value: AccessoryCandidateValue, bom: AccessoryBomRow[]) {
  const code = norm(value.accessory_code || '');
  if (code) {
    const hit = bom.find((b) => norm(b.material_code || '') === code);
    if (hit) return { id: hit.id, confidence: 1, reason: '辅料编码完全一致', fieldDiffs: compareAccessoryCandidateToBom(value, hit) };
  }
  const hit = bom.find((b) => normalizeCandidateKey({
    accessory_name: b.material_name ?? b.accessory_name ?? '',
    specification: b.spec ?? b.specification ?? null,
    color: b.color ?? null,
    usage_position: b.placement ?? b.usage_position ?? null,
  }) === normalizeCandidateKey(value));
  return hit ? { id: hit.id, confidence: 1, reason: '名称、规格、颜色和位置完全一致', fieldDiffs: compareAccessoryCandidateToBom(value, hit) } : null;
}
