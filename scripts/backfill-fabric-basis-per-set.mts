/**
 * 面料/里料 consumption_basis 显式确认为 PER_SET(2026-08-17)。
 *
 * 为什么是 PER_SET 而不是 PER_PIECE:
 *   [[set-order-fabric-per-set]] 2026-07-20 用户拍板 —— 套装订单**面料按「每套」口径**,
 *   单耗 0.317 视为整套用量,总需 = 套数 × 单耗 = 761kg;
 *   曾误按「每件×2」实现成 1522,被明确否掉。
 *   (我第一版打算回填 PER_PIECE,会把 1022222 从 152 翻到 304 —— 正是被否掉的那个错。)
 *
 * 数值影响:**零**。PER_SET 本来就是静默兜底用的口径,回填只是把它变成"人确认过"。
 *   意义在于:BomTab 修好后(口径未确认不再给数字),这些行才会重新显示总需量。
 *   真正修错数的是「按款 set_multiplier 折套数」那一刀,不是这里。
 *
 * 只碰 fabric/lining。辅料不动 —— 每套/每件由跟单确认,我没有依据替它们定。
 *
 * 用法:node --import tsx scripts/backfill-fabric-basis-per-set.mts [--apply]
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');
const TARGET = 'PER_SET';

const { data: orders } = await sb.from('orders')
  .select('id, order_no, internal_order_no, quantity_unit').ilike('quantity_unit', '%套%');

const targets: Array<{ id: string; order: string; name: string }> = [];
for (const o of (orders ?? []) as any[]) {
  const { data: bom } = await sb.from('materials_bom')
    .select('id, material_name, consumption_basis, qty_per_piece')
    .eq('order_id', o.id).in('material_type', ['fabric', 'lining']);
  for (const b of (bom ?? []) as any[]) {
    if (!b.consumption_basis) targets.push({ id: b.id, order: String(o.internal_order_no ?? o.order_no), name: String(b.material_name) });
  }
}

console.log(`\n${APPLY ? '⚙️  执行' : '🔍 DRY-RUN'} —— 面料/里料 consumption_basis: NULL → ${TARGET}(数值零变化)\n`);
for (const t of targets) console.log(`  ${t.order.padEnd(11)} ${t.name}`);
console.log(`\n合计 ${targets.length} 行,涉及 ${new Set(targets.map(t => t.order)).size} 张订单。`);
if (!APPLY) { console.log('\n未写库。加 --apply 执行。'); process.exit(0); }

let ok = 0;
for (const t of targets) {
  const { error } = await sb.from('materials_bom').update({ consumption_basis: TARGET }).eq('id', t.id);
  if (error) console.error(`  ✗ ${t.order} ${t.name}: ${error.message}`); else ok++;
}
// 回读校验:不能只信 update 没报错(本项目吃过静默写失败的亏)
const { data: verify } = await sb.from('materials_bom').select('id, consumption_basis').in('id', targets.map(t => t.id));
const bad = (verify ?? []).filter((v: any) => v.consumption_basis !== TARGET);
console.log(`\n✅ 已写 ${ok}/${targets.length} 行`);
console.log(bad.length === 0 ? `🔎 回读校验通过:${verify?.length ?? 0} 行口径已是 ${TARGET}` : `❌ 回读发现 ${bad.length} 行没写上`);
process.exit(bad.length === 0 ? 0 : 1);
