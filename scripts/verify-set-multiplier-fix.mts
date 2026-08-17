/**
 * 套装单面料需求 —— 修前/修后对照(只读,不写库)。2026-08-17
 *
 * 修的是:逐款算料时用**该款 set_multiplier** 折套数,而不是订单级 quantity_unit 串。
 * 期望:1022967 从 424 → 1272(CEO 确认值);1022222 等「套」单保持不变(件/套恰好=2)。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeMaterialRequirement } from '../lib/services/mrp.ts';

const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const normColor = (s: any) => String(s ?? '').trim().toLowerCase();

const { data: orders } = await sb.from('orders')
  .select('id, order_no, internal_order_no, quantity, quantity_unit').ilike('quantity_unit', '%套%');

console.log('\n订单        | 单位   | 物料                     | 单耗   | 件数  | 件/套 |     修前 →     修后');
let changed = 0, same = 0;
for (const o of (orders ?? []) as any[]) {
  const { data: li } = await sb.from('order_line_items')
    .select('style_no, color_cn, color_en, qty_pcs, set_multiplier').eq('order_id', o.id);
  const styleQty = new Map<string, number>(), styleColorQty = new Map<string, number>();
  const alias = new Map<string, string>(), setMul = new Map<string, number>();
  for (const r of (li ?? []) as any[]) {
    if (!r.style_no) continue;
    const m = Number(r.set_multiplier) > 0 ? Number(r.set_multiplier) : 1;
    if (!setMul.has(r.style_no)) setMul.set(r.style_no, m);
    const q = (Number(r.qty_pcs) || 0) * m;
    styleQty.set(r.style_no, (styleQty.get(r.style_no) || 0) + q);
    const canon = normColor(r.color_cn) || normColor(r.color_en);
    if (!canon) continue;
    const k = `${r.style_no}¦${canon}`;
    styleColorQty.set(k, (styleColorQty.get(k) || 0) + q);
    for (const c of [r.color_cn, r.color_en]) { const nc = normColor(c); if (nc) alias.set(`${r.style_no}¦${nc}`, k); }
  }
  const { data: bom } = await sb.from('materials_bom')
    .select('material_name, material_type, qty_per_piece, consumption_basis, style_no, color')
    .eq('order_id', o.id).in('material_type', ['fabric', 'lining']);
  for (const b of (bom ?? []) as any[]) {
    if (b.qty_per_piece == null) continue;
    let pieces = Number(o.quantity) || 0;
    const st = b.style_no || null;
    if (st && styleQty.get(st)) pieces = styleQty.get(st)!;
    if (st && String(b.color ?? '').trim()) {
      const bk = `${st}¦${normColor(b.color)}`;
      const cq = styleColorQty.get(alias.get(bk) || bk);
      if (cq && cq > 0) pieces = cq;
    }
    const mk = (mul: number | null) => computeMaterialRequirement({
      material: { material_name: b.material_name, material_type: b.material_type, material_code: null, unit: null, qty_per_piece: b.qty_per_piece, loss_rate: 0, consumption_basis: b.consumption_basis },
      po_quantity: pieces, quantityUnit: o.quantity_unit, componentsPerCommercialUnit: mul,
      stageAnchors: { factory_date: null } as any, today: '2026-08-17',
    }).gross_requirement;
    const before = mk(null), after = mk(st ? setMul.get(st) ?? null : null);
    const mark = before !== after ? ' ⬅ 变化' : '';
    if (before !== after) changed++; else same++;
    console.log(`${String(o.internal_order_no ?? o.order_no).padEnd(11)} | ${String(o.quantity_unit).padEnd(5)} | ${String(b.material_name).slice(0,22).padEnd(24)} | ${String(b.qty_per_piece).padStart(5)} | ${String(pieces).padStart(5)} | ${String(st ? setMul.get(st) ?? '-' : '-').padStart(4)} | ${String(before ?? '—').padStart(8)} → ${String(after ?? '—').padStart(8)}${mark}`);
  }
}
console.log(`\n合计:${changed} 行数量变化,${same} 行不变。`);
