/**
 * 纸箱规格 + 箱唛模板(#3)—— 纯类型 + 派生器,零副作用,server/client 共用。
 * 一套默认(整单共用)+ 例外(个别款/色大小不同)+ 箱唛模板(按款×色套变量)。
 */

export interface CartonDims { l?: number | string; w?: number | string; h?: number | string; }

export interface CartonFields {
  box_type?: string;                  // 箱型(如 外箱/内盒)
  dims_cm?: CartonDims;               // 外箱尺寸(长宽高 cm)
  pcs_per_box?: number | string;      // 每箱件数
  gross_kg?: number | string;         // 毛重
  net_kg?: number | string;           // 净重
}

export interface CartonException extends CartonFields {
  scope: 'style' | 'color';          // 例外维度:按款 / 按色
  style_no?: string;
  color?: string;
}

export interface CartonSpec {
  default?: CartonFields;
  exceptions?: CartonException[];
  mark_template?: string;             // 箱唛模板,变量 {PO}{款号}{颜色}{箱号}
}

export interface DerivedCartonRow {
  style_no: string; color: string; qty: number;
  box_type: string; dims: string; pcs_per_box: number | null;
  box_count: number | null; gross_kg: number | null; net_kg: number | null;
  mark: string;                       // 箱唛(模板已套变量)
}

const numOrNull = (v: any): number | null => { const n = Number(v); return v == null || v === '' || isNaN(n) ? null : n; };

/** 解析某款某色适用的纸箱字段:款专属例外 > 色例外 > 默认(逐字段覆盖)。 */
export function resolveCartonFields(spec: CartonSpec | null | undefined, styleNo: string, color: string): CartonFields {
  const def = spec?.default || {};
  const exs = Array.isArray(spec?.exceptions) ? spec!.exceptions! : [];
  const s = (styleNo || '').trim(), c = (color || '').trim();
  const colorEx = exs.find((e) => e.scope === 'color' && (e.color || '').trim() === c && c !== '');
  const styleEx = exs.find((e) => e.scope === 'style' && (e.style_no || '').trim() === s && s !== '');
  // 默认 → 色例外 → 款例外(款专属最优先)
  return { ...def, ...(colorEx || {}), ...(styleEx || {}) };
}

/** 箱唛模板套变量。 */
export function fillMark(tpl: string | undefined, v: { po?: string; style_no?: string; color?: string; box?: string }): string {
  return String(tpl || '')
    .replace(/\{PO\}/g, v.po || '')
    .replace(/\{款号\}/g, v.style_no || '')
    .replace(/\{颜色\}/g, v.color || '')
    .replace(/\{箱号\}/g, v.box || 'C/NO');
}

/** 按订单款×色明细派生每个纸箱行(纸箱字段 + 箱数 + 箱唛)。 */
export function deriveCartonRows(
  spec: CartonSpec | null | undefined,
  lines: Array<{ style_no?: string; color_cn?: string; color_en?: string; qty_pcs?: number | null; carton_count?: number | null }>,
  ctx: { po?: string },
): DerivedCartonRow[] {
  const rows: DerivedCartonRow[] = [];
  for (const l of (lines || [])) {
    const style_no = String(l.style_no || '').trim();
    const color = String(l.color_cn || l.color_en || '').trim();
    const qty = numOrNull(l.qty_pcs) || 0;
    const f = resolveCartonFields(spec, style_no, color);
    const pcs = numOrNull(f.pcs_per_box);
    const box_count = l.carton_count != null ? numOrNull(l.carton_count) : (pcs && qty ? Math.ceil(qty / pcs) : null);
    const dims = f.dims_cm ? [f.dims_cm.l, f.dims_cm.w, f.dims_cm.h].filter((x) => x != null && x !== '').join('×') : '';
    rows.push({
      style_no, color, qty,
      box_type: f.box_type || '', dims, pcs_per_box: pcs,
      box_count, gross_kg: numOrNull(f.gross_kg), net_kg: numOrNull(f.net_kg),
      mark: fillMark(spec?.mark_template, { po: ctx.po, style_no, color, box: box_count ? `1-${box_count}` : 'C/NO' }),
    });
  }
  return rows;
}
