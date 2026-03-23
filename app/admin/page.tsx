import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';
import Link from 'next/link';
import { TodayMustHandle } from '@/components/TodayMustHandle';
import { DelayRequestActions } from '@/components/DelayRequestActions';
import { BackfillButton } from '@/components/BackfillButton';
import { CeoAssistantActionPanel } from '@/components/CeoAssistantActionPanel';
import { AdminTabNav } from '@/components/AdminTabNav';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getRoleLabel } from '@/lib/utils/i18n';
import { inferRolesFromCategoryAndRequirement } from '@/lib/domain/requirements';
import { analyzeWarRoom } from '@/lib/warRoom/rootCauseEngine';
import { suggestActions, summarizeActions, CATEGORY_CONFIG } from '@/lib/warRoom/actionEngine';

const RISK_CONFIG = {
  CRITICAL: { label: 'CRITICAL', badge: 'bg-red-100 text-red-700 border-red-200', bar: 'bg-red-500' },
  HIGH:     { label: 'HIGH',     badge: 'bg-orange-100 text-orange-700 border-orange-200', bar: 'bg-orange-400' },
  MEDIUM:   { label: 'MEDIUM',   badge: 'bg-yellow-100 text-yellow-700 border-yellow-200', bar: 'bg-yellow-400' },
  LOW:      { label: 'LOW',      badge: 'bg-gray-100 text-gray-600 border-gray-200', bar: 'bg-gray-400' },
};

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const twoDaysLater = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // ── Shared data ──────────────────────────────────────────
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  const ordersWithMilestones: any[] = [];
  if (orders) {
    for (const o of orders as any[]) {
      const { data: ms } = await supabase.from('milestones').select('*').eq('order_id', o.id);
      ordersWithMilestones.push({ ...o, milestones: ms || [] });
    }
  }

  const { data: allMilestones } = await supabase.from('milestones').select('*').order('due_at', { ascending: true });

  // ── Tab 1: 概览 ─────────────────────────────────────────
  const overdueMilestones = (allMilestones || []).filter((m: any) =>
    m.status !== '已完成' && m.due_at && isOverdue(m.due_at)
  );
  const blockedMilestones = (allMilestones || []).filter((m: any) => m.status === '卡住');

  const riskRed = ordersWithMilestones.filter((o: any) => computeOrderStatus(o.milestones || []).color === 'RED');
  const riskYellow = ordersWithMilestones.filter((o: any) => computeOrderStatus(o.milestones || []).color === 'YELLOW');
  const riskGreen = ordersWithMilestones.filter((o: any) => computeOrderStatus(o.milestones || []).color === 'GREEN');

  // Today Must Handle
  const { data: allMilestonesWithOrders } = await (supabase.from('milestones') as any)
    .select('id, order_id, name, owner_role, owner_user_id, due_at, status, orders!inner(id, order_no, customer_name)')
    .order('due_at', { ascending: true });

  const todayMustHandleMilestones = (allMilestonesWithOrders || []).filter((m: any) => {
    if (m.status === '卡住') return true;
    if (m.status === '进行中' && m.due_at && new Date(m.due_at) <= tomorrow) return true;
    if (m.status !== '已完成' && m.due_at && new Date(m.due_at) < now) return true;
    return false;
  });

  const ownerUserIds = [...new Set(todayMustHandleMilestones.map((m: any) => m.owner_user_id).filter(Boolean))] as string[];
  let userMap: Record<string, any> = {};
  if (ownerUserIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role')
      .in('user_id', ownerUserIds);
    if (profiles) userMap = (profiles as any[]).reduce((acc: any, p: any) => { acc[p.user_id] = p; return acc; }, {});
  }

  const milestoneIds = todayMustHandleMilestones.map((m: any) => m.id);
  let delayRequestMap: Record<string, boolean> = {};
  if (milestoneIds.length > 0) {
    const { data: dr } = await (supabase.from('delay_requests') as any)
      .select('milestone_id').in('milestone_id', milestoneIds).eq('status', 'pending');
    if (dr) delayRequestMap = (dr as any[]).reduce((acc: any, x: any) => ({ ...acc, [x.milestone_id]: true }), {});
  }

  const formattedTodayMilestones = todayMustHandleMilestones.map((m: any) => ({
    id: m.id, order_id: m.order_id, name: m.name, owner_role: m.owner_role,
    owner_user_id: m.owner_user_id,
    owner_user: m.owner_user_id && userMap[m.owner_user_id]
      ? { user_id: m.owner_user_id, email: userMap[m.owner_user_id].email, full_name: userMap[m.owner_user_id].name || userMap[m.owner_user_id].email }
      : null,
    due_at: m.due_at, status: m.status,
    order_no: m.orders?.order_no || '', customer_name: m.orders?.customer_name || '',
    has_pending_delay: !!delayRequestMap[m.id],
  }));

  // Bottlenecks
  const bottlenecksByRole: Record<string, number> = {};
  (allMilestones || []).forEach((m: any) => {
    if (m.status === '卡住' || (m.status !== '已完成' && m.due_at && isOverdue(m.due_at))) {
      bottlenecksByRole[m.owner_role] = (bottlenecksByRole[m.owner_role] || 0) + 1;
    }
  });

  // ── Tab 2: 问题中心 (War Room) ──────────────────────────
  const warRoomData = analyzeWarRoom(ordersWithMilestones as any);
  const focusOrders = warRoomData.slice(0, 3);

  const criticalCount = warRoomData.filter(w => w.riskLevel === 'CRITICAL').length;
  const highCount = warRoomData.filter(w => w.riskLevel === 'HIGH').length;
  const clearCount = (orders?.length || 0) - warRoomData.length;

  // Department heatmap
  const roleHeatMap: Record<string, { overdue: number; blocked: number }> = {};
  for (const wr of warRoomData) {
    for (const m of wr.order.milestones) {
      if (m.status === '已完成') continue;
      const r = m.owner_role;
      if (!roleHeatMap[r]) roleHeatMap[r] = { overdue: 0, blocked: 0 };
      if (m.due_at && new Date(m.due_at) < now) roleHeatMap[r].overdue++;
      if (m.status === '阻塞') roleHeatMap[r].blocked++;
    }
  }
  const RLABELS: Record<string, string> = { sales: '业务', finance: '财务', procurement: '采购', production: '生产', qc: '质检', logistics: '物流' };
  const heatRows = Object.entries(roleHeatMap)
    .map(([r, v]) => ({ role: r, label: RLABELS[r] || r, total: v.overdue + v.blocked, ...v }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);
  const heatMax = heatRows[0]?.total || 1;

  // Department issue summary
  interface DeptSummary { role: string; riskOrders: Set<string>; overdueMilestones: number; pendingChangeItems: number; }
  const deptSummary: Record<string, DeptSummary> = {};
  function ensureDept(role: string) {
    if (!deptSummary[role]) deptSummary[role] = { role, riskOrders: new Set(), overdueMilestones: 0, pendingChangeItems: 0 };
    return deptSummary[role];
  }
  riskRed.forEach((o: any) => {
    const ms = (ordersWithMilestones.find((x: any) => x.id === o.id)?.milestones || []) as any[];
    const roles = new Set<string>();
    ms.forEach((m: any) => { if (m.owner_role) roles.add(m.owner_role); });
    roles.forEach((r) => ensureDept(r).riskOrders.add(o.id));
  });
  (allMilestones || []).forEach((m: any) => {
    if (!m.owner_role || m.status === '已完成') return;
    if (m.due_at && isOverdue(m.due_at)) ensureDept(m.owner_role).overdueMilestones += 1;
  });
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: requirementMemories } = await (supabase.from('customer_memory') as any)
    .select('order_id, category, source_type, content_json, created_at')
    .not('order_id', 'is', null)
    .gte('created_at', ninetyDaysAgo);
  (requirementMemories || []).forEach((m: any) => {
    const t = (m.content_json?.requirement_type || '') as string;
    if (t !== 'change' && t !== 'pending') return;
    const roles = inferRolesFromCategoryAndRequirement(m.category, m.source_type);
    roles.forEach((r) => ensureDept(r).pendingChangeItems++);
  });

  // ── Tab 3: 行动建议 ────────────────────────────────────
  const allWarRoomActions = suggestActions(focusOrders);
  const actionSummary = summarizeActions(allWarRoomActions);

  // Pending delay requests
  const { data: pendingDelayRequests } = await (supabase.from('delay_requests') as any)
    .select('*, milestones!inner(id, name, order_id, orders!inner(id, order_no, customer_name))')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // CEO action items
  interface CEOActionItem {
    id: string; kind: 'overdue' | 'blocked_24h' | 'pending_delay' | 'red_risk_soon';
    order_id: string; order_no: string; milestone_id: string; reason: string; suggestion: string;
  }
  const actionItems: CEOActionItem[] = [];
  let overdueActionCount = 0, blockedOver24Count = 0, redRiskSoonCount = 0;
  const pendingDelayCount = (pendingDelayRequests || []).length;

  ordersWithMilestones.forEach((o: any) => {
    (o.milestones || []).forEach((m: any) => {
      const dueAt = m.due_at ? new Date(m.due_at) : null;
      if (m.status === '进行中' && dueAt && isOverdue(m.due_at)) {
        overdueActionCount++;
        const daysOver = Math.max(1, Math.floor((now.getTime() - dueAt.getTime()) / (24 * 60 * 60 * 1000)));
        actionItems.push({ id: `overdue-${m.id}`, kind: 'overdue', order_id: o.id, order_no: o.order_no, milestone_id: m.id,
          reason: `${m.name} 已逾期 ${daysOver} 天`, suggestion: '建议立即催办负责人，并确认新的完成时间或调整交期。' });
      }
      if (m.status === '卡住') {
        const updatedAt = m.updated_at ? new Date(m.updated_at) : null;
        if (!updatedAt || updatedAt < oneDayAgo) {
          blockedOver24Count++;
          actionItems.push({ id: `blocked-${m.id}`, kind: 'blocked_24h', order_id: o.id, order_no: o.order_no, milestone_id: m.id,
            reason: `${m.name} 阻塞超过24小时`, suggestion: '建议与负责人沟通解除阻塞，必要时调整资源或优先级。' });
        }
      }
    });
    const status = computeOrderStatus(o.milestones || []);
    if (status.color === 'YELLOW') {
      const upcoming = (o.milestones || [])
        .filter((m: any) => m.status !== '已完成' && m.due_at)
        .map((m: any) => ({ ...m, due: new Date(m.due_at) }))
        .filter((m: any) => m.due >= now && m.due <= twoDaysLater)
        .sort((a: any, b: any) => a.due.getTime() - b.due.getTime());
      if (upcoming.length > 0) {
        redRiskSoonCount++;
        actionItems.push({ id: `redsoon-${o.id}`, kind: 'red_risk_soon', order_id: o.id, order_no: o.order_no, milestone_id: upcoming[0].id,
          reason: `订单在未来48小时内有关键节点（${upcoming[0].name}），当前为黄色风险。`, suggestion: '建议提前复盘时间线，防止订单滑入红色风险。' });
      }
    }
  });

  (pendingDelayRequests || []).forEach((req: any) => {
    const ms = req.milestones; const order = ms?.orders;
    if (!ms || !order) return;
    const createdAt = req.created_at ? new Date(req.created_at) : null;
    const daysPending = createdAt ? Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000))) : 0;
    actionItems.push({ id: `delay-${req.id}`, kind: 'pending_delay', order_id: order.id, order_no: order.order_no, milestone_id: ms.id,
      reason: `延期申请已等待审批${daysPending}天`, suggestion: '建议尽快审批延期，或要求团队补充客户确认证据。' });
  });

  const todaySummary = actionItems.length === 0
    ? '今日整体运行平稳，暂无需要你立即决策的事项。'
    : `今日共有 ${overdueActionCount} 个逾期节点、${blockedOver24Count} 个节点阻塞超过24小时、${pendingDelayCount} 个延期申请待审批、${redRiskSoonCount} 个订单在48小时内可能进入红色风险。`;

  // Tomorrow risk
  const { data: tomorrowRiskMilestones } = await (supabase.from('milestones') as any)
    .select('id, order_id, name, due_at, status, orders!inner(id, order_no, customer_name)')
    .gte('due_at', tomorrow.toISOString())
    .lt('due_at', twoDaysLater.toISOString())
    .neq('status', '已完成');

  // ── Render ──────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">管理看板</h1>
            <p className="text-sm text-gray-500">全局概览 · 风险分析 · 行动决策</p>
          </div>
        </div>
        <BackfillButton />
      </div>

      <AdminTabNav
        overviewContent={
          <OverviewTab
            riskRed={riskRed} riskYellow={riskYellow} riskGreen={riskGreen}
            overdueMilestones={overdueMilestones} blockedMilestones={blockedMilestones}
            formattedTodayMilestones={formattedTodayMilestones}
            bottlenecksByRole={bottlenecksByRole}
          />
        }
        issuesContent={
          <IssuesTab
            criticalCount={criticalCount} highCount={highCount} clearCount={clearCount}
            focusOrders={focusOrders} warRoomData={warRoomData}
            heatRows={heatRows} heatMax={heatMax} deptSummary={deptSummary}
          />
        }
        actionsContent={
          <ActionsTab
            actionItems={actionItems} todaySummary={todaySummary}
            allWarRoomActions={allWarRoomActions} actionSummary={actionSummary}
            focusOrders={focusOrders}
            pendingDelayRequests={pendingDelayRequests}
            tomorrowRiskMilestones={tomorrowRiskMilestones}
          />
        }
      />
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tab 1: 概览
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function OverviewTab({ riskRed, riskYellow, riskGreen, overdueMilestones, blockedMilestones, formattedTodayMilestones, bottlenecksByRole }: any) {
  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon="🔴" label="红色风险" value={riskRed.length} color="text-red-600" bg="bg-red-100" />
        <StatCard icon="🟡" label="黄色关注" value={riskYellow.length} color="text-yellow-600" bg="bg-yellow-100" />
        <StatCard icon="⏰" label="逾期节点" value={overdueMilestones.length} color="text-orange-600" bg="bg-orange-100" />
        <StatCard icon="🚫" label="阻塞节点" value={blockedMilestones.length} color="text-purple-600" bg="bg-purple-100" />
      </div>

      {/* Today Must Handle */}
      <TodayMustHandle milestones={formattedTodayMilestones} />

      {/* Risk Orders */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">订单风险概览</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <RiskColumn label="红色风险" count={riskRed.length} orders={riskRed} colorClass="border-red-200 bg-red-50" textClass="text-red-800" />
          <RiskColumn label="黄色关注" count={riskYellow.length} orders={riskYellow} colorClass="border-yellow-200 bg-yellow-50" textClass="text-yellow-800" />
          <RiskColumn label="绿色正常" count={riskGreen.length} orders={riskGreen} colorClass="border-green-200 bg-green-50" textClass="text-green-800" />
        </div>
      </div>

      {/* Bottleneck */}
      {Object.keys(bottlenecksByRole).length > 0 && (
        <div className="section">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">角色瓶颈分析</h2>
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <table className="table-modern">
              <thead><tr><th>责任角色</th><th>逾期/阻塞</th><th>占比</th></tr></thead>
              <tbody>
                {Object.entries(bottlenecksByRole).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([role, count]) => {
                  const total = Object.values(bottlenecksByRole).reduce((s: number, c: number) => s + c, 0);
                  const pct = total > 0 ? Math.round(((count as number) / total) * 100) : 0;
                  return (
                    <tr key={role}>
                      <td><span className="font-medium text-gray-900">{getRoleLabel(role)}</span></td>
                      <td><span className="badge badge-danger">{count as number}</span></td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden max-w-24">
                            <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-sm text-gray-500">{pct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color, bg }: { icon: string; label: string; value: number; color: string; bg: string }) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-2 mb-2">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${bg}`}>
          <span className="text-sm">{icon}</span>
        </div>
        <span className="text-xs font-medium text-gray-500">{label}</span>
      </div>
      <div className={`stat-value ${color}`}>{value}</div>
    </div>
  );
}

function RiskColumn({ label, count, orders, colorClass, textClass }: any) {
  return (
    <div className={`rounded-lg border-2 p-4 ${colorClass}`}>
      <h3 className={`text-base font-semibold mb-2 ${textClass}`}>{label}（{count}）</h3>
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {count === 0 ? <p className="text-gray-500 text-sm">无</p> : (
          orders.slice(0, 8).map((o: any) => (
            <Link key={o.id} href={`/orders/${o.id}`} className={`block text-sm hover:underline ${textClass}`}>
              {o.order_no} — {o.customer_name}
            </Link>
          ))
        )}
        {count > 8 && <p className="text-xs text-gray-500">共 {count} 单</p>}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tab 2: 问题中心
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function IssuesTab({ criticalCount, highCount, clearCount, focusOrders, warRoomData, heatRows, heatMax, deptSummary }: any) {
  return (
    <div className="space-y-6">
      {/* Situation overview */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">CRITICAL</p>
          <p className={`text-3xl font-black ${criticalCount > 0 ? 'text-red-500' : 'text-gray-300'}`}>{criticalCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">需立即决策</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">HIGH</p>
          <p className={`text-3xl font-black ${highCount > 0 ? 'text-orange-500' : 'text-gray-300'}`}>{highCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">需今日跟进</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">运转正常</p>
          <p className="text-3xl font-black text-green-500">{clearCount}</p>
          <p className="text-xs text-gray-400 mt-0.5">风险可控</p>
        </div>
      </div>

      {/* No issues */}
      {focusOrders.length === 0 && (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-12 text-center">
          <p className="text-4xl mb-3">✅</p>
          <p className="text-lg font-semibold text-gray-900">所有订单风险可控</p>
          <p className="text-sm text-gray-500">当前无需介入的决策事项</p>
        </div>
      )}

      {/* Focus orders with root cause analysis */}
      {focusOrders.map((wr: any, idx: number) => {
        const cfg = RISK_CONFIG[wr.riskLevel as keyof typeof RISK_CONFIG];
        const anchor = wr.order.etd || wr.order.eta || wr.order.warehouse_due_date;
        return (
          <div key={wr.order.id} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            {/* Order header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-black text-gray-300">#{idx + 1}</span>
                <div>
                  <div className="flex items-center gap-2">
                    <Link href={`/orders/${wr.order.id}`} className="font-bold text-gray-900 hover:text-indigo-600">{wr.order.order_no}</Link>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${cfg.badge}`}>{cfg.label}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {wr.order.customer_name}
                    {anchor && (' · ETD ' + new Date(anchor).toLocaleDateString('zh-CN'))}
                    {wr.daysToAnchor !== null && (
                      <span className={wr.daysToAnchor <= 7 ? ' text-red-500 font-semibold' : ''}>
                        {wr.daysToAnchor <= 0 ? '（已过出货日）' : ` （还有 ${wr.daysToAnchor} 天）`}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-black text-gray-300">{wr.riskScore}</p>
                <p className="text-xs text-gray-400">风险分</p>
              </div>
            </div>

            {/* Root cause + quick stats */}
            <div className="px-6 py-5">
              <div className="grid grid-cols-3 gap-2 mb-5">
                {[
                  { label: '逾期节点', v: wr.overdueCount, alert: wr.overdueCount > 0 },
                  { label: '阻塞节点', v: wr.blockedCount, alert: wr.blockedCount > 0 },
                  { label: '无负责人', v: wr.unassignedCriticalCount, alert: wr.unassignedCriticalCount >= 3 },
                ].map(s => (
                  <div key={s.label} className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-center">
                    <p className={`text-xl font-bold ${s.alert ? 'text-red-500' : 'text-gray-400'}`}>{s.v}</p>
                    <p className="text-xs text-gray-500">{s.label}</p>
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">根因分析</p>
              <div className="space-y-3">
                {wr.rootCauses.length === 0 ? (
                  <p className="text-sm text-gray-400">未检出明显根因</p>
                ) : wr.rootCauses.map((cause: any) => (
                  <div key={cause.code} className="flex gap-2.5">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      cause.severity === 'CRITICAL' ? 'bg-red-500' :
                      cause.severity === 'HIGH' ? 'bg-orange-400' : 'bg-yellow-400'
                    }`} />
                    <div>
                      <p className="text-sm font-medium text-gray-900">{cause.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{cause.detail}</p>
                      {cause.impactedStages.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {cause.impactedStages.map((s: string) => (
                            <span key={s} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{s}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      {/* Other risk orders */}
      {warRoomData.length > 3 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">其他关注订单</p>
          <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
            {warRoomData.slice(3).map((wr: any) => {
              const cfg = RISK_CONFIG[wr.riskLevel as keyof typeof RISK_CONFIG];
              return (
                <Link key={wr.order.id} href={`/orders/${wr.order.id}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${cfg.badge}`}>{cfg.label}</span>
                    <span className="text-sm font-medium text-gray-900">{wr.order.order_no}</span>
                    <span className="text-xs text-gray-500">{wr.order.customer_name}</span>
                  </div>
                  <span className="text-gray-300">→</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Department heatmap */}
      {heatRows.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">部门瓶颈热力图</p>
          <div className="rounded-xl border border-gray-200 bg-white px-6 py-5 space-y-3">
            {heatRows.map((r: any) => (
              <div key={r.role} className="flex items-center gap-4">
                <span className="w-12 text-xs text-gray-500 text-right flex-shrink-0">{r.label}</span>
                <div className="flex-1 flex items-center gap-1 h-5">
                  {r.overdue > 0 && (
                    <div className="h-full rounded flex items-center justify-end pr-2"
                      style={{ width: `${Math.max(8, r.overdue / heatMax * 100)}%`, background: 'rgba(239,68,68,0.15)' }}>
                      <span className="text-xs text-red-600 font-medium">{r.overdue}</span>
                    </div>
                  )}
                  {r.blocked > 0 && (
                    <div className="h-full rounded flex items-center justify-end pr-2"
                      style={{ width: `${Math.max(6, r.blocked / heatMax * 60)}%`, background: 'rgba(251,146,60,0.15)' }}>
                      <span className="text-xs text-orange-600 font-medium">{r.blocked}</span>
                    </div>
                  )}
                </div>
                <span className="text-xs text-gray-400 w-6 text-right">{r.total}</span>
              </div>
            ))}
            <div className="flex gap-4 pt-2 border-t border-gray-100">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded" style={{ background: 'rgba(239,68,68,0.25)' }} /><span className="text-xs text-gray-500">逾期</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded" style={{ background: 'rgba(251,146,60,0.25)' }} /><span className="text-xs text-gray-500">阻塞</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Department issue summary */}
      {Object.keys(deptSummary).length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">部门问题汇总</h2>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500">
                  <th className="text-left py-2 font-medium">部门</th>
                  <th className="text-left py-2 font-medium">风险订单</th>
                  <th className="text-left py-2 font-medium">逾期节点</th>
                  <th className="text-left py-2 font-medium">变更/待澄清</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(deptSummary)
                  .sort((a: any, b: any) => (b.riskOrders.size + b.overdueMilestones) - (a.riskOrders.size + a.overdueMilestones))
                  .map((d: any) => (
                    <tr key={d.role} className="border-b border-gray-50">
                      <td className="py-2 font-medium text-gray-900">{getRoleLabel(d.role)}</td>
                      <td className="py-2">{d.riskOrders.size}</td>
                      <td className="py-2">{d.overdueMilestones}</td>
                      <td className="py-2">{d.pendingChangeItems}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tab 3: 行动建议
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function ActionsTab({ actionItems, todaySummary, allWarRoomActions, actionSummary, focusOrders, pendingDelayRequests, tomorrowRiskMilestones }: any) {
  return (
    <div className="space-y-6">
      {/* CEO assistant */}
      <CeoAssistantActionPanel
        items={actionItems.slice(0, 10)}
        pendingDelayCount={(pendingDelayRequests || []).length}
        summaryText={todaySummary}
      />

      {/* War Room actions */}
      {allWarRoomActions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">规则引擎建议</h2>
            <span className="text-xs text-gray-500">
              共 {actionSummary.total} 条，其中 {actionSummary.immediate} 条需立即处理
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {allWarRoomActions.map((action: any) => {
              const catCfg = CATEGORY_CONFIG[action.category as keyof typeof CATEGORY_CONFIG];
              return (
                <div key={action.id} className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">{action.icon}</span>
                      <span className="text-sm font-semibold text-gray-900">{action.label}</span>
                    </div>
                    {catCfg && (
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${catCfg.style}`}>
                        {catCfg.label}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed mb-3">{action.description}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">→ {action.targetRole}</span>
                    <Link href={action.ctaHref}
                      className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors">
                      {action.ctaLabel}
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pending delays */}
      <div id="delay-approvals">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">待审批延期</h2>
        {!pendingDelayRequests || pendingDelayRequests.length === 0 ? (
          <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl">暂无待审批延期</div>
        ) : (
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {(pendingDelayRequests as any[]).map((req: any) => (
              <div key={req.id} className="rounded-xl border border-yellow-200 bg-yellow-50/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-gray-900">{req.milestones?.name || '未知节点'}</span>
                      <span className="badge badge-warning">待审批</span>
                    </div>
                    <div className="text-sm text-gray-600">
                      <Link href={`/orders/${req.milestones?.order_id}`} className="text-indigo-600 hover:text-indigo-700 font-medium">
                        {req.milestones?.orders?.order_no}
                      </Link>
                      {' · '}{req.milestones?.orders?.customer_name}
                    </div>
                    <div className="text-sm text-gray-500 mt-1">原因: {req.reason_type}</div>
                    {req.proposed_new_due_at && <div className="text-sm text-gray-500">新截止: {formatDate(req.proposed_new_due_at)}</div>}
                    <div className="text-xs text-gray-400 mt-1">提交: {formatDate(req.created_at)}</div>
                  </div>
                  <DelayRequestActions delayRequestId={req.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tomorrow risk */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">明日提醒</h2>
        {!tomorrowRiskMilestones || tomorrowRiskMilestones.length === 0 ? (
          <div className="text-center py-6 text-gray-400 bg-gray-50 rounded-xl text-sm">未来 24-48 小时内暂无关键节点进入风险窗口</div>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-50">
            {(tomorrowRiskMilestones as any[]).slice(0, 10).map((m: any) => (
              <Link key={m.id} href={`/orders/${m.order_id}#milestone-${m.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
                <div>
                  <span className="text-sm font-medium text-gray-900">{m.orders?.order_no}</span>
                  <span className="text-sm text-gray-500 ml-2">{m.name}</span>
                </div>
                <span className="text-xs text-gray-400">到期: {formatDate(m.due_at)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
