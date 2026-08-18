/**
 * DRY-RUN:清理混进 order_line_items.sizes 的伪尺码列(2026-08-18)。
 *
 * 背景:Excel/AI 解析把「QTY (PCS)」当成尺码写进了 sizes,导致按配比分摊时多吃一份
 * (5184÷7 而不是 ÷6)。代码侧已由 4858366 修好(keepSizeLabels),本脚本只处理**存量脏数据**。
 *
 * ⚠️ 最关键的一点:sizes 的各码之和就是 qty_pcs(商业数量/套数)。
 *    如果伪尺码的值**被计入了** qty_pcs,那删掉它就会改变订单数量 —— 那是数量修正,
 *    不是数据清理,必须走完全不同的审批。本脚本第一件事就是把这个判清楚。
 *
 * 默认只读。--apply 才写(且只有在 Σ 不变的前提下才允许)。
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSizeLabel } from '../lib/utils/size-sort.ts';

const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

const { data: rows, error } = await sb.from('order_line_items')
  .select('id, order_id, style_no, color_cn, color_en, sizes, qty_pcs, set_multiplier');
if (error) { console.error('读明细失败:', error.message); process.exit(1); }

const dirty = (rows ?? []).filter((r: any) => Object.keys(r.sizes || {}).some((k) => !isSizeLabel(k)));
const oids = [...new Set(dirty.map((r: any) => r.order_id))];
const oMap = new Map<string, any>();
for (let i = 0; i < oids.length; i += 200) {
  const { data } = await sb.from('orders').select('id, order_no, internal_order_no, quantity, lifecycle_status').in('id', oids.slice(i, i + 200));
  for (const o of (data ?? []) as any[]) oMap.set(o.id, o);
}

console.log(`\n${APPLY ? '⚙️  执行' : '🔍 DRY-RUN(未写库)'} —— 清理伪尺码列\n`);
console.log(`扫描 ${rows?.length ?? 0} 行明细,发现脏行 ${dirty.length} 行,涉及 ${oids.length} 张订单\n`);

let safe = 0, unsafe = 0;
const plan: any[] = [];
for (const r of dirty as any[]) {
  const o = oMap.get(r.order_id);
  const sizes = r.sizes || {};
  const bad = Object.keys(sizes).filter((k) => !isSizeLabel(k));
  const good = Object.keys(sizes).filter((k) => isSizeLabel(k));
  const sumAll = Object.values(sizes).reduce((a: any, b: any) => a + (Number(b) || 0), 0) as number;
  const sumGood = good.reduce((a, k) => a + (Number(sizes[k]) || 0), 0);
  const badVal = bad.reduce((a, k) => a + (Number(sizes[k]) || 0), 0);
  const qtyPcs = Number(r.qty_pcs) || 0;

  // 判定:删掉伪尺码后 Σ 是否仍等于 qty_pcs(权威商业数量)
  const qtyMatchesAll = sumAll === qtyPcs;
  const qtyMatchesGood = sumGood === qtyPcs;
  const verdict = qtyMatchesGood ? '✅ 安全(qty_pcs 本就只含真尺码)'
    : qtyMatchesAll ? '❌ 不安全(qty_pcs 含伪尺码值,删=改数量)'
      : '⚠️ 待查(qty_pcs 与两种口径都对不上)';
  if (qtyMatchesGood) safe++; else unsafe++;

  console.log(`【${o?.internal_order_no ?? o?.order_no}】${o?.lifecycle_status} 款${r.style_no}/${r.color_cn || r.color_en}`);
  console.log(`   删除键: ${bad.map((k) => `"${k}"=${sizes[k]}`).join(', ')}`);
  console.log(`   改前: ${JSON.stringify(sizes)}`);
  console.log(`   改后: ${JSON.stringify(Object.fromEntries(good.map((k) => [k, sizes[k]])))}`);
  console.log(`   Σ全部=${sumAll}  Σ真尺码=${sumGood}  伪尺码值=${badVal}  qty_pcs=${qtyPcs}`);
  console.log(`   → ${verdict}\n`);
  plan.push({ id: r.id, good: Object.fromEntries(good.map((k) => [k, sizes[k]])), safeToApply: qtyMatchesGood });
}

console.log(`═══ 汇总:安全 ${safe} 行 · 不安全/待查 ${unsafe} 行 ═══`);
if (unsafe > 0) {
  console.log('\n⛔ 存在不安全行 —— 删除伪尺码会改变订单数量,那属于数量修正而非数据清理,');
  console.log('   必须由业务确认真实数量后走正规修正通道,本脚本拒绝写库。');
}
if (!APPLY) { console.log('\n(未写库。全部安全时才可加 --apply)\n'); process.exit(0); }
if (unsafe > 0) { console.error('\n❌ 有不安全行,拒绝执行。\n'); process.exit(1); }

let ok = 0;
for (const it of plan) {
  const { error: e } = await sb.from('order_line_items').update({ sizes: it.good }).eq('id', it.id);
  if (e) console.error(`  ✗ ${it.id}: ${e.message}`); else ok++;
}
const { data: verify } = await sb.from('order_line_items').select('id, sizes').in('id', plan.map((x) => x.id));
const still = (verify ?? []).filter((v: any) => Object.keys(v.sizes || {}).some((k) => !isSizeLabel(k)));
console.log(`\n✅ 已清理 ${ok}/${plan.length} 行`);
console.log(still.length === 0 ? '🔎 回读校验通过:无残留伪尺码\n' : `❌ 回读仍有 ${still.length} 行含伪尺码\n`);
