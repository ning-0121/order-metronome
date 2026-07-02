/**
 * 物料目录 — 纯逻辑(SC-P1)
 * 单位换算:确定性、可测、无副作用。数据由 action 从 material_uom 拉。
 */

export interface UomRow {
  from_unit: string;
  to_unit: string;
  factor: number; // 1 from_unit = factor to_unit
}

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const norm = (u: unknown) => (u ?? '').toString().trim().toLowerCase();

/**
 * 单位换算。支持:同单位(×1)/ 正向(from→to ×factor)/ 反向(to→from ÷factor)。
 * 无换算路径 → null(调用方决定是否报错,不臆造)。
 */
export function convertUnit(qty: number, from: string, to: string, rows: UomRow[]): number | null {
  const q = Number(qty) || 0;
  const f = norm(from), t = norm(to);
  if (!f || !t) return null;
  if (f === t) return round3(q);
  for (const r of rows || []) {
    const rf = norm(r.from_unit), rt = norm(r.to_unit), factor = Number(r.factor);
    if (!(factor > 0)) continue;
    if (rf === f && rt === t) return round3(q * factor);        // 正向
    if (rf === t && rt === f) return round3(q / factor);        // 反向
  }
  return null; // 无换算路径
}
