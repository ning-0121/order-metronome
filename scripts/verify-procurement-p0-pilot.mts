/**
 * Procurement Generator P0 —— 真实 Pilot 生产验收(**只读**,不写任何东西)
 *
 * 用法:npx tsx scripts/verify-procurement-p0-pilot.mts <订单号>
 *
 * CEO 定的 8 项验收里,能从库里客观判定的只有一部分。本脚本严格区分:
 *   【断言】机器能判真假 → PASS/FAIL
 *   【呈现】需要人看数字对不对 → 打表,不给结论
 *   【人工】只能在真人操作中观察 → 脚本不碰,列出来提醒
 *
 * 不做的事(重要):
 *   - 不重算归并数量。total_required_qty 面料走「件数×大货单耗」、客供行整行跳过,
 *     不是 Σ net_purchase_qty。在这里复刻一遍就是造第二套算法 —— 那正是要防的东西。
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

if (!fs.existsSync('.env.local')) {
  console.error('❌ 找不到 .env.local。先跑 `vercel env pull .env.local`(别手写 —— 手写的那份和线上不一致过)。');
  process.exit(1);
}
for (const l of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const i = l.indexOf('='); if (i < 0 || l.trim().startsWith('#')) continue;
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ .env.local 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。');
  process.exit(1);
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const target = process.argv[2];
if (!target) { console.error('用法: npx tsx scripts/verify-procurement-p0-pilot.mts <订单号>'); process.exit(1); }

const ok = (b: boolean) => (b ? '✅ PASS' : '❌ FAIL');
let allPass = true;
const fail = () => { allPass = false; };

// ── 订单 ──────────────────────────────────────────────
const { data: o } = await svc.from('orders')
  .select('id, order_no, internal_order_no, quantity, created_at')
  .or(`order_no.eq.${target},internal_order_no.eq.${target}`).maybeSingle();
if (!o) { console.error(`❌ 订单不存在:${target}`); process.exit(1); }
const oid = (o as any).id;
console.log(`\n■ ${(o as any).order_no}  (内部单号 ${(o as any).internal_order_no || '—'})  数量 ${(o as any).quantity}`);

// ── ① Pilot 名单:第一张只开一张 ───────────────────────
const raw = String(process.env.PROCUREMENT_GENERATOR_PILOT ?? '').trim();
const list = !raw || /^(off|false|0|no)$/i.test(raw) ? [] : raw.split(/[,;\s]+/).filter(Boolean);
const inList = list.map((s) => s.toUpperCase())
  .some((k) => [(o as any).order_no, (o as any).internal_order_no]
    .some((v) => String(v ?? '').trim().toUpperCase() === k));
const c1 = inList && list.length === 1;
if (!c1) fail();
console.log(`\n【断言】① Pilot 名单只有这一张         ${ok(c1)}   名单=[${list.join(', ') || '空'}]`);

// ── ② BOM 口径是否齐(决定应该停在哪个状态)────────────
const { data: bom } = await svc.from('materials_bom')
  .select('id, material_name, consumption_basis, qty_per_piece, unit, color')
  .eq('order_id', oid);
const bomRows = (bom || []) as any[];
const VALID = new Set(['PER_SET', 'PER_PIECE', 'PER_COMPONENT', 'PER_ORDER']);
const unconfirmed = bomRows.filter((b) => !VALID.has(String(b.consumption_basis ?? '')));
console.log(`\n【断言】② BOM ${bomRows.length} 行,口径未确认 ${unconfirmed.length} 行`);
if (unconfirmed.length > 0) {
  console.log(`         → 期望状态 NEEDS_BOM_CONFIRMATION,**不应**有采购项`);
  for (const b of unconfirmed.slice(0, 10)) console.log(`           · ${b.material_name}`);
}

// ── ③ 需求 + 计划 ─────────────────────────────────────
const { data: reqs } = await svc.from('material_requirements')
  .select('id, material_name, category, unit, net_purchase_qty, pieces_qty').eq('order_id', oid);
const reqRows = (reqs || []) as any[];
const { data: plan } = await svc.from('material_plans')
  .select('mrp_generated_at, plan_status').eq('order_id', oid).maybeSingle();

// ── ④ 采购项:自动产生了没有 ───────────────────────────
const { data: items } = await svc.from('procurement_items')
  .select('id, item_no, consolidation_key, material_name, color, unit, total_required_qty, source_count, suggested_purchase_qty, status, created_at')
  .eq('order_id', oid).order('item_no');
const itemRows = (items || []) as any[];

const shouldHaveItems = unconfirmed.length === 0 && reqRows.length > 0;
const c4 = shouldHaveItems ? itemRows.length > 0 : itemRows.length === 0;
if (!c4) fail();
console.log(`\n【断言】④ 采购项自动产生               ${ok(c4)}   需求 ${reqRows.length} 条 → 采购项 ${itemRows.length} 项` +
  (shouldHaveItems ? '' : '(口径未齐,期望 0 项)'));

// ── ⑤ 归并不变量(不重算数量,只查结构性守恒)──────────
if (itemRows.length > 0) {
  const sumSrc = itemRows.reduce((s, i) => s + (Number(i.source_count) || 0), 0);
  const i1 = itemRows.length <= reqRows.length;                       // 归并只会变少
  const i2 = sumSrc <= reqRows.length;                                // 来源数不许超过需求总数(防重复计入)
  const i3 = itemRows.every((i) => (Number(i.source_count) || 0) >= 1);  // 无零来源的凭空项
  const i4 = itemRows.every((i) => Number(i.total_required_qty) > 0);    // 无空数量项
  const i5 = new Set(itemRows.map((i) => i.consolidation_key)).size === itemRows.length;  // 归并键唯一
  if (!(i1 && i2 && i3 && i4 && i5)) fail();
  console.log(`\n【断言】⑤ 归并结构守恒`);
  console.log(`         项数 ≤ 需求数              ${ok(i1)}   ${itemRows.length} ≤ ${reqRows.length}`);
  console.log(`         Σ来源数 ≤ 需求数(防重复)  ${ok(i2)}   ${sumSrc} ≤ ${reqRows.length}`);
  console.log(`         无零来源项                ${ok(i3)}`);
  console.log(`         无空数量项                ${ok(i4)}`);
  console.log(`         归并键唯一                ${ok(i5)}`);
  if (sumSrc < reqRows.length) {
    console.log(`         ⚠️ ${reqRows.length - sumSrc} 条需求未进任何采购项 —— 正常原因是客供/加工厂承担(不采购),请人工确认确实如此`);
  }
}

// ── ⑥ 自动 vs 人手:采购项是不是跟 MRP 同一次提交产生的 ──
if (itemRows.length > 0 && (plan as any)?.mrp_generated_at) {
  const mrpAt = new Date((plan as any).mrp_generated_at).getTime();
  const firstItemAt = Math.min(...itemRows.map((i) => new Date(i.created_at).getTime()));
  const gapSec = Math.round((firstItemAt - mrpAt) / 1000);
  const c6 = gapSec >= 0 && gapSec <= 120;   // 同一次提交内完成 = 系统自动,不是事后有人去点归并
  if (!c6) fail();
  console.log(`\n【断言】⑥ 归并是自动发生的             ${ok(c6)}   MRP 与首个采购项相差 ${gapSec}s(>120s 说明还是人手点的)`);
}

// ── ⑦ 执行行不变量:生产行必须挂 procurement_item_id ───
const { data: lines } = await svc.from('procurement_line_items')
  .select('id, procurement_item_id, category, material_name, line_status, status, ordered_qty, created_at')
  .eq('order_id', oid);
const lineRows = (lines || []) as any[];
const orphans = lineRows.filter((l) => String(l.category ?? '') !== '成品大货' && !l.procurement_item_id);
const c7 = orphans.length === 0;
if (!c7) fail();
console.log(`\n【断言】⑦ 无孤儿执行行                 ${ok(c7)}   执行行 ${lineRows.length} 行,孤儿 ${orphans.length} 行`);
for (const l of orphans.slice(0, 10)) console.log(`           · ${l.id} ${l.material_name}(建于 ${String(l.created_at).slice(0, 19)})`);
if (lineRows.length === 0) console.log(`         (P0 阶段执行行本就为 0 —— 采购确认后才生成,此项此时只证明入口没被绕过)`);

// ── ⑧ 只写 line_status,不写 legacy status ────────────
const legacyWrites = lineRows.filter((l) => l.status != null && String(l.status).trim() !== '');
const c8 = legacyWrites.length === 0;
if (!c8) fail();
console.log(`\n【断言】⑧ 新行不写 legacy status       ${ok(c8)}   有 status 值的行 ${legacyWrites.length}`);

// ── ⑨ 采购台账对本单零新增 ────────────────────────────
const { data: track } = await svc.from('procurement_tracking')
  .select('id, item_name, created_at').eq('order_id', oid).order('created_at', { ascending: false });
const trackRows = (track || []) as any[];
console.log(`\n【呈现】⑨ 采购台账现存 ${trackRows.length} 行` +
  (trackRows.length ? `,最近一行建于 ${String(trackRows[0].created_at).slice(0, 19)}` : ''));
console.log(`         → 请确认最近一行**早于**开 Pilot 的时间(停写生效);历史行保留是预期的`);

// ── 【呈现】数量对账表:交给跟单/采购看,不给结论 ────────
if (itemRows.length > 0) {
  console.log(`\n【呈现】待采购 ${itemRows.length} 项 —— 请跟单/采购逐行核对数量口径`);
  console.log(`  ${'物料'.padEnd(22)}${'色'.padEnd(8)}${'单位'.padEnd(6)}${'总需求'.padStart(10)}${'建议采购'.padStart(10)}${'来源'.padStart(6)}  状态`);
  for (const i of itemRows) {
    console.log(`  ${String(i.material_name ?? '').slice(0, 20).padEnd(22)}` +
      `${String(i.color ?? '—').slice(0, 6).padEnd(8)}${String(i.unit ?? '').padEnd(6)}` +
      `${String(i.total_required_qty ?? '').padStart(10)}${String(i.suggested_purchase_qty ?? '').padStart(10)}` +
      `${String(i.source_count ?? '').padStart(6)}  ${i.status}`);
  }
}

// ── 【人工】只能在真人操作里观察的 ─────────────────────
console.log(`\n【人工】以下三项脚本判不了,必须真人确认:`);
console.log(`  · 跟单提交 BOM 后,**没有**再去任何页面点「归并」`);
console.log(`  · 口径缺失时页面确实显示 NEEDS_BOM_CONFIRMATION 并点名到物料`);
console.log(`  · 采购打开页面第一眼就看到「待采购 ${itemRows.length} 项」`);
console.log(`\n【人工】非 Pilot 对照单:随便找一张不在名单的单,`);
console.log(`  确认采购台账仍可新增、旧对账入口仍可用 —— 证明非 Pilot 行为零变化。`);

console.log(`\n${allPass ? '✅ 可断言项全部 PASS' : '❌ 有断言项未通过 —— 先停,不要扩大 Pilot'}\n`);
process.exit(allPass ? 0 : 1);
