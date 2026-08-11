/**
 * CEO 驾驶舱聚合(2026-07-27 CEO:重建我的节拍——监控而非瓶颈)。
 * 一次性算出 A–E 五区块,喂 components/ceo/CeoCockpit.tsx。自带查询、不依赖页面变量,复用已有服务。
 *   A 需我审批 + 可疑延期  B 五部门健康/异常  C 新增(订单/打样/工厂/供应商)  D 需关注客户/订单  E 员工工作报告
 * 只读聚合;金额/敏感不进此层(驾驶舱是监控面,不是审批执行面)。
 */
import { getPendingApprovals, CATEGORY_META, type ApprovalCategory } from '@/lib/services/pending-approvals.service';

const DONE = new Set(['done', '已完成', 'completed']);
/** 已终结的订单(真的走完/作废了)。用于"近30天完成数"这类**产出统计**。 */
const TERMINAL_LC = new Set(['completed', '已完成', 'cancelled', '已取消', 'archived', '已归档', '已复盘']);

/**
 * 不计逾期的订单生命周期 = 已终结 ∪ **尚未激活**。
 *
 * 未激活的三种:draft(草稿) / pending_approval(待审批) / paused(暂停) —— 这些单还没真正开跑,
 * 却因为 po_confirmed 的 due = 下单当天(schedule.ts TIMELINE.po_confirmed = 0),
 * 一建出来就天天累计逾期,把 CEO 驾驶舱的数字顶得很高。
 *
 * ⚠️ 必须与工作台 app/dashboard/page.tsx 的 `.not('orders.lifecycle_status', 'in', ...)`
 * 保持同一份名单 —— 2026-07-28 CEO 质疑"逾期数虚高"时只改了工作台、漏了驾驶舱,
 * 同一批单在两个页面显示不同的逾期数(2026-07-30 对齐)。改一处必须改另一处。
 *
 * ⚠️ 别把这三种并进 TERMINAL_LC:那个集合被"近30天完成数"用着,
 * 并进去会把草稿/暂停单统计成"已完成"。两个集合各司其职,不要合并。
 */
const NO_OVERDUE_LC = new Set([...TERMINAL_LC, 'draft', 'pending_approval', 'paused']);
const isDone = (s: any) => DONE.has(String(s || '').toLowerCase()) || DONE.has(String(s || ''));

/** owner_role → 五部门 */
const DEPT_OF_ROLE: Record<string, string> = {
  sales: 'dev', sales_manager: 'dev',
  merchandiser: 'exec', order_manager: 'exec',
  production: 'prod', production_manager: 'prod', qc: 'prod',
  procurement: 'purch', procurement_manager: 'purch',
  finance: 'fin', logistics: 'prod',
};
export const DEPT_META: { key: string; label: string; href: string }[] = [
  { key: 'dev', label: '订单开发', href: '/orders' },
  { key: 'exec', label: '订单执行', href: '/orders' },
  { key: 'prod', label: '生产中心', href: '/production' },
  { key: 'purch', label: '采购中心', href: '/procurement' },
  { key: 'fin', label: '财务', href: '/dashboard' },
];

export interface CeoOrderRef { orderNo: string; orderId: string; node: string; days?: number }
export interface CeoCockpit {
  A: { total: number; groups: { key: string; label: string; count: number }[]; suspiciousDelays: { orderNo: string; orderId: string; customer: string; days: number; reason: string }[] };
  B: { key: string; label: string; href: string; active: number; overdue: number; blocked: number; pendingDelay: number; overdueOrders: CeoOrderRef[] }[];
  C: { newOrders7d: number; newOrders30d: number; completed7d: number; sampleActive: number; newSuppliers7d: number; newFactories7d: number; recent: { orderNo: string; orderId: string; customer: string; at: string; purpose: string }[] };
  D: { matters: { customer: string; title: string; severity: string; orderNo: string | null; orderId: string | null }[]; stuck: { orderNo: string; orderId: string; customer: string; node: string; days: number }[] };
  E: { name: string; deptLabel: string; active: number; overdue: number; done30d: number; onTimePct: number | null }[];
}

export async function getCeoCockpit(supabase: any, ctx: { userId: string; roles: string[] }): Promise<CeoCockpit> {
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();

  // ── A:待我审批(复用聚合)+ 可疑延期 ──
  const approvals = await getPendingApprovals(supabase, ctx).catch(() => ({ ok: false as const }));
  const aData = (approvals as any).ok ? (approvals as any).data : { total: 0, byCategory: {} };
  const ORDER: ApprovalCategory[] = ['order_cancel', 'price', 'delay', 'ceo_import', 'payment_hold', 'agent_action', 'order_confirm'];
  const groups = ORDER.map((cat) => ({ key: cat, label: (CATEGORY_META as any)[cat]?.label || cat, count: Number((aData.byCategory as any)?.[cat] || 0) })).filter((g) => g.count > 0);

  // ── 订单 + 里程碑(B/C/D/E 共用一次拉) ──
  const { data: orders } = await supabase.from('orders')
    .select('id, order_no, internal_order_no, customer_name, order_purpose, lifecycle_status, created_at, factory_date, owner_user_id, created_by')
    .order('created_at', { ascending: false }).limit(2000);
  // "在办/计逾期"的口径:排除已终结 **和** 尚未激活(草稿/待审批/暂停)的订单,与工作台对齐。
  const notTerminal = (o: any) => !NO_OVERDUE_LC.has(String(o.lifecycle_status || '').toLowerCase()) && !NO_OVERDUE_LC.has(String(o.lifecycle_status || ''));
  // 打样单不进 B(部门健康)/E(员工)/D(卡住)/里程碑逾期口径——避免打样延期污染部门健康度与员工准时率
  //   (打样上线前审计)。C 段 sampleActive 另从全量单单独统计,不受影响。
  const liveOrders = ((orders || []) as any[]).filter((o) => notTerminal(o) && (o.order_purpose || 'production') !== 'sample');
  const sampleActiveCount = ((orders || []) as any[]).filter((o) => notTerminal(o) && String(o.order_purpose) === 'sample').length;
  const orderById = new Map<string, any>(((orders || []) as any[]).map((o) => [o.id, o]));
  const liveIds = liveOrders.map((o) => o.id);
  const { data: ms } = liveIds.length > 0
    ? await supabase.from('milestones').select('id, name, status, due_at, actual_at, owner_role, owner_user_id, order_id, step_key, sequence_number').in('order_id', liveIds)
    : { data: [] };
  // 业务执行固定节点归一化到订单业务负责人(2026-07-28 审计 P1-3):B 部门计分/E 员工准时率不再把
  // 产前样寄出/确认等节点算到生产头上(与工作台/订单详情同口径 effectiveMilestoneOwner)。
  const { effectiveMilestoneOwner } = await import('@/lib/domain/milestone-owner');
  const milestones = ((ms || []) as any[]).map((m) => {
    const o = orderById.get(m.order_id);
    return o ? effectiveMilestoneOwner(m, o) : m;
  });

  // 可疑延期:大额(≥21天)或同单反复(≥2条)——从 pending delay 拉。
  // 同时收集"已申请延期(待批)的节点",逾期口径把它们剔除(与首页 dashboard 一致:责任人已行动不算逾期)。
  const { data: pendingDelays } = await supabase.from('delay_requests')
    .select('order_id, milestone_id, delay_days, status').eq('status', 'pending').limit(300);
  const pendingDelayMs = new Set<string>(((pendingDelays || []) as any[]).map((d) => d.milestone_id).filter(Boolean));

  // ── 待收尾单:出厂日已过 + 长期没人点过任何节点 → 逾期不计入预警(CEO 2026-08-04)──
  //
  // CEO 原话:「历史的逾期,已经出货了或者已经解决了,但是一直显示在这里,
  // 影响了判断的敏锐度,系统就没有预警意义了。」
  //
  // 实测:372 个逾期节点里 **164 个(44%)** 落在「出厂日已过 + 14 天没有任何节点被点完成」
  // 的 21 张单上。这类单绝大多数是货已出、只是没人回来维护节拍器;
  // 还有一类是**补录历史单** —— 出厂日在过去,一建出来所有节点 due_at 就全过期
  // (如 1022919 建单当天即 15 个逾期)。两者都不是"正在晚",却把真正要盯的 33% 淹了。
  //
  // 判活跃用 actual_at(节点真被点完成的时刻),**不能用 updated_at** ——
  // 后者会被批量维护操作(改负责人、补倍率等)刷新,看上去人人都在动。
  //
  // 处理方式是**拆分不是隐藏**:这些单单独进 staleOrders 一栏,提示去「确认整单已出货」
  // (订单详情页那个按钮,一键把出运前节点补齐)。收尾后它们自然消失。
  const STALE_IDLE_DAYS = 14;
  const staleOrderIds = new Set<string>();
  {
    const lastActBy = new Map<string, number>();
    for (const mm of milestones) {
      const t = mm.actual_at ? new Date(mm.actual_at).getTime() : 0;
      if (t > (lastActBy.get(mm.order_id) || 0)) lastActBy.set(mm.order_id, t);
    }
    for (const [oid, o] of orderById) {
      const fd = (o as any)?.factory_date ? String((o as any).factory_date).slice(0, 10) : null;
      if (!fd) continue;
      if (new Date(fd + 'T23:59:59').getTime() >= now) continue;          // 出厂日还没到 → 正常在途
      const last = lastActBy.get(oid) || 0;
      const idleDays = last ? Math.floor((now - last) / 86400000) : Infinity;   // 从没点过 → 视为最不活跃
      if (idleDays > STALE_IDLE_DAYS) staleOrderIds.add(oid);
    }
  }

  const isOverdue = (mm: any) => !!mm.due_at && new Date(mm.due_at).getTime() < now
    && !pendingDelayMs.has(mm.id)
    && !staleOrderIds.has(mm.order_id);   // 待收尾单不计入预警,另立一栏
  const byOrder = new Map<string, { count: number; maxDays: number }>();
  for (const d of ((pendingDelays || []) as any[])) {
    const cur = byOrder.get(d.order_id) || { count: 0, maxDays: 0 };
    cur.count += 1; cur.maxDays = Math.max(cur.maxDays, Number(d.delay_days) || 0);
    byOrder.set(d.order_id, cur);
  }
  const suspiciousDelays = [...byOrder.entries()].filter(([oid, v]) => (v.maxDays >= 21 || v.count >= 2) && (orderById.get(oid)?.order_purpose || 'production') !== 'sample')
    .map(([oid, v]) => { const o = orderById.get(oid); return { orderNo: o?.internal_order_no || o?.order_no || String(oid).slice(0, 8), orderId: oid, customer: o?.customer_name || '', days: v.maxDays, reason: v.count >= 2 ? `同单 ${v.count} 次延期` : `单次 ${v.maxDays} 天` }; })
    .sort((a, b) => b.days - a.days).slice(0, 8);

  // ── 滚动排期(混合方案,ROLLING_SCHEDULE flag 包住)──
  // 前置节点没全部完成的节点 = waiting,不算逾期(根治"客户拖上游、下游跟单采购假逾期")。
  // 可开始节点按「前置完成日 + N 工作日」判逾期。cockpit 是 admin-only 视图 → isAdmin=true(admin 灰度即生效)。
  const { rollingScheduleActive } = await import('@/lib/engine/featureFlags');
  const useRolling = rollingScheduleActive(true);
  type _NS = import('@/lib/schedule/rollingSchedule').NodeSchedule;
  const rollSched = new Map<string, _NS>();   // key `${order_id}:${step_key}`
  if (useRolling) {
    const { deriveRollingSchedule } = await import('@/lib/schedule/rollingSchedule');
    const { V3_SIGNATURE_STEPS } = await import('@/lib/milestoneTemplate');
    const byOrd = new Map<string, any[]>();
    for (const mm of milestones) { const a = byOrd.get(mm.order_id) || []; a.push(mm); byOrd.set(mm.order_id, a); }
    for (const [oid, list] of byOrd) {
      const o = orderById.get(oid);
      const isV3 = list.some((m: any) => (V3_SIGNATURE_STEPS as readonly string[]).includes(m.step_key));
      const orderStartMs = o?.created_at ? new Date(o.created_at).getTime() : now;
      for (const [k, v] of deriveRollingSchedule(list, { isV3, orderStartMs, nowMs: now })) rollSched.set(`${oid}:${k}`, v);
    }
  }
  // 逾期判定:flag on 走滚动(仍叠加延期待批/待收尾豁免);否则老锚点口径。
  const nodeOverdue = (mm: any): boolean => {
    if (pendingDelayMs.has(mm.id) || staleOrderIds.has(mm.order_id)) return false;
    if (useRolling) return rollSched.get(`${mm.order_id}:${mm.step_key}`)?.overdue ?? false;
    return isOverdue(mm);
  };
  const overdueDays = (mm: any): number => {
    if (useRolling) { const rd = rollSched.get(`${mm.order_id}:${mm.step_key}`)?.rollingDue; return rd ? Math.max(0, Math.floor((now - rd.getTime()) / 86400000)) : 0; }
    return mm.due_at ? Math.max(0, Math.floor((now - new Date(mm.due_at).getTime()) / 86400000)) : 0;
  };

  // ── B:五部门健康/异常(每部门收集逾期订单清单,供点开看详情)──
  const deptAgg: Record<string, { active: number; overdue: number; blocked: number; pendingDelay: number }> = {};
  const deptOverdue: Record<string, Map<string, { node: string; days: number }>> = {};
  for (const m of DEPT_META) { deptAgg[m.key] = { active: 0, overdue: 0, blocked: 0, pendingDelay: 0 }; deptOverdue[m.key] = new Map(); }
  for (const mm of milestones) {
    const dept = DEPT_OF_ROLE[String(mm.owner_role || '').toLowerCase()];
    if (!dept || !deptAgg[dept]) continue;
    const st = String(mm.status || '').toLowerCase();
    if (isDone(mm.status)) continue;
    deptAgg[dept].active += 1;
    if (st === 'blocked' || st === '卡单' || st === '卡住') deptAgg[dept].blocked += 1;
    if (nodeOverdue(mm)) {   // 滚动口径:waiting 节点不计;已申请延期(待批)不计
      deptAgg[dept].overdue += 1;
      const days = overdueDays(mm);
      const prev = deptOverdue[dept].get(mm.order_id);
      if (!prev || days > prev.days) deptOverdue[dept].set(mm.order_id, { node: mm.name || '', days });  // 每单取最久逾期节点
    }
  }
  const B = DEPT_META.map((m) => ({
    key: m.key, label: m.label, href: m.href, ...deptAgg[m.key],
    overdueOrders: [...deptOverdue[m.key].entries()].map(([oid, v]) => { const o = orderById.get(oid); return { orderNo: o?.internal_order_no || o?.order_no || String(oid).slice(0, 8), orderId: oid, node: v.node, days: v.days }; }).sort((a, b) => b.days - a.days).slice(0, 20),
  }));

  // ── C:新增情况 ──
  const newOrders7d = ((orders || []) as any[]).filter((o) => o.created_at >= d7).length;
  const newOrders30d = ((orders || []) as any[]).filter((o) => o.created_at >= d30).length;
  const completed7d = ((orders || []) as any[]).filter((o) => TERMINAL_LC.has(String(o.lifecycle_status || '')) && o.created_at >= d30).length; // 近30天里已完成(粗)
  const sampleActive = sampleActiveCount;   // 独立统计(liveOrders 已排除打样)
  let newSuppliers7d = 0, newFactories7d = 0;
  try { const { count } = await supabase.from('suppliers').select('id', { count: 'exact', head: true }).gte('created_at', d7); newSuppliers7d = count || 0; } catch { /* 表/列缺失忽略 */ }
  try { const { count } = await supabase.from('factories').select('id', { count: 'exact', head: true }).gte('created_at', d7); newFactories7d = count || 0; } catch { /* 无 factories 表忽略 */ }
  const recent = ((orders || []) as any[]).slice(0, 8).map((o) => ({ orderNo: o.internal_order_no || o.order_no, orderId: o.id, customer: o.customer_name || '', at: String(o.created_at || '').slice(0, 10), purpose: String(o.order_purpose || 'production') }));

  // ── D:需关注客户/订单 ──
  let matters: CeoCockpit['D']['matters'] = [];
  try {
    const { data: cm } = await supabase.from('customer_matters').select('customer_name, order_id, order_no, severity, title').order('detected_at', { ascending: false }).limit(10);
    matters = ((cm || []) as any[]).map((r) => ({ customer: r.customer_name || '', title: r.title || '', severity: r.severity || 'info', orderNo: r.order_no || null, orderId: r.order_id || null }));
  } catch { /* 表缺失忽略 */ }
  // 卡住订单:有 blocked 里程碑
  const stuckMap = new Map<string, { node: string; days: number }>();
  for (const mm of milestones) {
    const st = String(mm.status || '').toLowerCase();
    if (st === 'blocked' || st === '卡单' || st === '卡住') {
      if (!stuckMap.has(mm.order_id)) stuckMap.set(mm.order_id, { node: mm.name || '', days: mm.due_at ? Math.max(0, Math.floor((now - new Date(mm.due_at).getTime()) / 86400000)) : 0 });
    }
  }
  const stuck = [...stuckMap.entries()].map(([oid, v]) => { const o = orderById.get(oid); return { orderNo: o?.internal_order_no || o?.order_no || String(oid).slice(0, 8), orderId: oid, customer: o?.customer_name || '', node: v.node, days: v.days }; }).sort((a, b) => b.days - a.days).slice(0, 8);

  // ── E:员工工作报告 ──
  const empIds = [...new Set(milestones.map((m) => m.owner_user_id).filter(Boolean))] as string[];
  const nameMap = new Map<string, { name: string; role: string }>();
  if (empIds.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('user_id, name, email, role, roles').in('user_id', empIds);
    for (const p of ((profs || []) as any[])) {
      const role = (Array.isArray(p.roles) && p.roles[0]) || p.role || '';
      nameMap.set(p.user_id, { name: p.name || (p.email ? String(p.email).split('@')[0] : '—'), role });
    }
  }
  const empAgg = new Map<string, { active: number; overdue: number; done30d: number; onTime: number; onTimeTotal: number }>();
  for (const mm of milestones) {
    const uid = mm.owner_user_id; if (!uid) continue;
    const a = empAgg.get(uid) || { active: 0, overdue: 0, done30d: 0, onTime: 0, onTimeTotal: 0 };
    if (isDone(mm.status)) {
      if (mm.actual_at && mm.actual_at >= d30) a.done30d += 1;
      if (mm.actual_at && mm.due_at) { a.onTimeTotal += 1; if (new Date(mm.actual_at).getTime() <= new Date(mm.due_at).getTime()) a.onTime += 1; }
    } else {
      a.active += 1;
      if (nodeOverdue(mm)) a.overdue += 1;   // 滚动口径与 B 段部门卡一致(否则同页两处逾期数自相矛盾);已申请延期不计
    }
    empAgg.set(uid, a);
  }
  const E = [...empAgg.entries()].map(([uid, a]) => {
    const p = nameMap.get(uid) || { name: '—', role: '' };
    const dept = DEPT_META.find((d) => d.key === DEPT_OF_ROLE[String(p.role).toLowerCase()]);
    return { name: p.name, deptLabel: dept?.label || '其它', active: a.active, overdue: a.overdue, done30d: a.done30d, onTimePct: a.onTimeTotal > 0 ? Math.round((a.onTime / a.onTimeTotal) * 100) : null };
  }).filter((e) => e.active > 0 || e.done30d > 0).sort((a, b) => b.overdue - a.overdue || b.active - a.active).slice(0, 30);

  return {
    A: { total: Number(aData.total) || 0, groups, suspiciousDelays },
    B, C: { newOrders7d, newOrders30d, completed7d, sampleActive, newSuppliers7d, newFactories7d, recent }, D: { matters, stuck }, E,
  };
}
