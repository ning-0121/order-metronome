import ExcelJS from 'exceljs';

export type AccessoryCandidateValue = {
  accessory_code: string | null; accessory_name: string; specification: string | null;
  color: string | null; usage_position: string | null; unit: string | null;
  unit_consumption: number | null; consumption_basis: string | null; quantity: number | null;
};

const aliases: Record<keyof AccessoryCandidateValue, string[]> = {
  accessory_code: ['辅料编码','物料编码','编码','code'], accessory_name: ['辅料名称','物料名称','名称','name'],
  specification: ['规格','specification','spec'], color: ['颜色','color'],
  usage_position: ['使用部位','位置','部位','usage position','position'], unit: ['单位','unit'],
  unit_consumption: ['单耗','单位用量','unit consumption'], consumption_basis: ['用量基准','计价基准','consumption basis'],
  quantity: ['数量','总需数量','quantity','qty'],
};
const text = (v: ExcelJS.CellValue) => v == null ? '' : typeof v === 'object' && 'text' in v ? String(v.text).trim() : String(v).trim();
const norm = (v: string) => v.trim().toLowerCase().replace(/[\s\-_（）()]/g, '');

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
        const number = (s: string) => s !== '' && Number.isFinite(Number(s)) ? Number(s) : null;
        const normalized: AccessoryCandidateValue = {
          accessory_code: get('accessory_code') || null, accessory_name: name, specification: get('specification') || null,
          color: get('color') || null, usage_position: get('usage_position') || null, unit: get('unit') || null,
          unit_consumption: number(get('unit_consumption')), consumption_basis: get('consumption_basis') || null, quantity: number(get('quantity')),
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

export function matchAccessory(value: AccessoryCandidateValue, bom: any[]) {
  const code = norm(value.accessory_code || '');
  if (code) { const hit = bom.find(b => norm(b.material_code || '') === code); if (hit) return { id: hit.id, confidence: 1, reason: '辅料编码完全一致' }; }
  const key = (v: any) => [v.material_name ?? v.accessory_name, v.spec ?? v.specification, v.color, v.placement ?? v.usage_position].map(x => norm(String(x || ''))).join('|');
  const hit = bom.find(b => key(b) === key(value));
  return hit ? { id: hit.id, confidence: 1, reason: '名称、规格、颜色和位置完全一致' } : null;
}
