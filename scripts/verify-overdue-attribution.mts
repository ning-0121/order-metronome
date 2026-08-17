/**
 * Overdue Attribution V1 —— 生产数据 before/after 证据(**只读,不写任何表**)。
 *
 * 回答 CEO 的 F 条:新口径下 actionable / blocked / delivery-risk 各是多少,
 * 谁现在能动、谁在等谁、有多少责任配置异常;并逐个解释 581/580/588/564A/1022927。
 *
 * 用法:node --import tsx scripts/verify-overdue-attribution.mts
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attributeOrderOverdue, assessDeliveryRisk, summarize, buildPersonalView,
  roleLabel, isDoneStatus, type AttributedMilestone,
} from '../lib/domain/overdue-attribution.ts';

const p = resolve(process.cwd(), '.env.local');
if (existsSync(p)) for (const l of readFileSync(p, 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const NOW = Date.now();

// ── 取数(只读)──
const { data: orders, error: oErr } = await sb.from('orders')
  .select('id, order_no, internal_order_no, customer_name, factory_date, owner_user_id, lifecycle_status')
  .eq('lifecycle_status', 'active');
if (oErr) { console.error('读订单失败:', oErr.message); process.exit(1); }
const oids = (orders ?? []).map((o: any) => o.id);

let allMs: any[] = [];
for (let i = 0; i < oids.length; i += 200) {
  const { data, error } = await sb.from('milestones')
    .select('id, order_id, step_key, name, status, due_at, owner_role, owner_user_id, notes, sequence_number')
    .in('order_id', oids.slice(i, i + 200));
  if (error) { console.error('读节点失败:', error.message); process.exit(1); }
  allMs = allMs.concat(data ?? []);
}
const byOrder = new Map<string, any[]>();
for (const m of allMs) {
  if (!byOrder.has(m.order_id)) byOrder.set(m.order_id, []);
  byOrder.get(m.order_id)!.push(m);
}

const userIds = new Set<string>();
for (const m of allMs) if (m.owner_user_id) userIds.add(m.owner_user_id);
for (const o of (orders ?? []) as any[]) if (o.owner_user_id) userIds.add(o.owner_user_id);
const nameById = new Map<string, string>();
if (userIds.size) {
  const { data: profs } = await sb.from('profiles').select('user_id, name, full_name').in('user_id', [...userIds]);
  for (const p of (profs ?? []) as any[]) nameById.set(p.user_id, p.full_name || p.name || p.user_id.slice(0, 8));
}

// ── 归属计算 ──
const attributedByOrder = new Map<string, AttributedMilestone[]>();
let flat: AttributedMilestone[] = [];
for (const [oid, ms] of byOrder) {
  const a = attributeOrderOverdue(ms, NOW, nameById);
  attributedByOrder.set(oid, a);
  flat = flat.concat(a);
}
const s = summarize(flat);

// ── 旧口径(对照)──
const legacyOverdue = allMs.filter((m) => !isDoneStatus(m.status) && m.due_at && new Date(m.due_at).getTime() < NOW);
const legacyBlocked = legacyOverdue.filter((m) => String(m.status) === 'blocked').length;
const ownerOf = new Map((orders ?? []).map((o: any) => [o.id, o.owner_user_id]));
const legacyMismatch = legacyOverdue.filter((m) => m.owner_user_id && ownerOf.get(m.order_id) && m.owner_user_id !== ownerOf.get(m.order_id)).length;

console.log('\n══════ BEFORE(旧口径:一个「逾期」数字)══════');
console.log(`  在途订单            ${oids.length}`);
console.log(`  逾期节点            ${legacyOverdue.length}`);
console.log(`  其中 status=blocked ${legacyBlocked}  ← 仍压在个人逾期里`);
console.log(`  节点责任人≠订单负责人 ${legacyMismatch}  ← 却按订单业务段负责人点名`);

console.log('\n══════ AFTER(Overdue Attribution V1)══════');
console.log(`  逾期节点总数        ${s.totalOverdue}`);
console.log(`  ├ ACTIONABLE_OVERDUE ${s.actionable}   ← 现在真有人能动,唯一可用于个人 KPI`);
console.log(`  └ BLOCKED            ${s.blocked}   ← 在等别人/前置,不计被阻塞人的逾期`);
console.log(`  责任配置异常(UNASSIGNED) ${s.unassigned}`);

console.log('\n  ACTIONABLE 按责任部门:');
Object.entries(s.actionableByRole).sort((a, b) => b[1] - a[1])
  .forEach(([r, n]) => console.log(`     ${String(roleLabel(r) || r).padEnd(14)} ${String(n).padStart(4)}  ${(n / Math.max(1, s.actionable) * 100).toFixed(0)}%`));

console.log('\n  BLOCKED 按 blocker 部门(等谁):');
Object.entries(s.blockedByBlockerRole).sort((a, b) => b[1] - a[1])
  .forEach(([r, n]) => console.log(`     ${String(roleLabel(r) || r).padEnd(14)} ${String(n).padStart(4)}`));

console.log('\n  BLOCKED 按证据强度(能不能说清等谁):');
Object.entries(s.blockedByEvidence).forEach(([e, n]) => console.log(`     ${e.padEnd(20)} ${String(n).padStart(4)}`));

// ── 订单级交付风险 ──
let late = 0, atRisk = 0;
for (const o of (orders ?? []) as any[]) {
  const r = assessDeliveryRisk({ factoryDate: o.factory_date ? String(o.factory_date).slice(0, 10) : null, attributed: attributedByOrder.get(o.id) ?? [], now: NOW });
  if (r.level === 'late') late++; else if (r.level === 'at_risk') atRisk++;
}
console.log(`\n  DELIVERY_RISK(订单级,不算个人):  late ${late} 张 · at_risk ${atRisk} 张`);

// ── 五个真实案例 ──
const CASES = ['581', '580', '588', '564A', '1022927'];
console.log('\n══════ 五个真实案例:以前算谁 → 现在算谁 ══════');
for (const no of CASES) {
  const o: any = (orders ?? []).find((x: any) => String(x.internal_order_no) === no);
  if (!o) { console.log(`\n【${no}】未找到(可能不在 active)`); continue; }
  const att = attributedByOrder.get(o.id) ?? [];
  const ownerName = o.owner_user_id ? (nameById.get(o.owner_user_id) || '?') : '(无)';
  const risk = assessDeliveryRisk({ factoryDate: o.factory_date ? String(o.factory_date).slice(0, 10) : null, attributed: att, now: NOW });

  console.log(`\n【${no}】${o.order_no} 客户=${o.customer_name ?? '-'} 出厂=${o.factory_date ?? '-'}`);
  console.log(`   BEFORE:督办列表显示「${ownerName}:${att.length} 项逾期」—— 全部记在订单负责人头上`);
  console.log(`   AFTER :`);
  for (const a of att) {
    const tag = a.bucket === 'ACTIONABLE_OVERDUE' ? '🔴 可行动' : '⏸ 阻塞中';
    console.log(`      ${tag} ${String(a.milestone.name).padEnd(12)} 责任=${a.attribution.label}` +
      (a.bucket === 'BLOCKED' ? `  ${a.blocker?.label}` : `  (逾期 ${a.overdueDays} 天)`));
  }
  const mine = att.filter((a) => a.attribution.kind === 'user' && a.attribution.userId === o.owner_user_id && a.bucket === 'ACTIONABLE_OVERDUE');
  console.log(`   ${ownerName} 个人待办:${mine.length} 项(其余进「正在卡我的」或「知情」,不计入其绩效)`);
  console.log(`   CEO 看到:交付风险 ${risk.level.toUpperCase()} —— ${risk.reason}`);
}

// ── 责任配置异常清单(OWNERSHIP-MAPPING) ──
const anomalies = flat.filter((a) => a.attribution.isOwnershipDefect);
console.log(`\n══════ 责任配置异常(UNASSIGNED)${anomalies.length} 项 ══════`);
for (const a of anomalies.slice(0, 15)) {
  const o: any = (orders ?? []).find((x: any) => x.id === (a.milestone as any).order_id);
  console.log(`   ${String(o?.internal_order_no ?? o?.order_no ?? '?').padEnd(11)} ${a.milestone.name}  [step=${a.milestone.step_key}]`);
}
if (anomalies.length > 15) console.log(`   … 其余 ${anomalies.length - 15} 项`);

console.log('\n※ 本脚本只读,未修改任何数据。\n');
