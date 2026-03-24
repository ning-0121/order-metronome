import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole, ROLE_LABEL } from '@/lib/utils/user-role';
import { buildExecutionTasks, summarizeExecutionTasks } from '@/lib/warRoom/executionBridge';
import { analyzeWarRoom } from '@/lib/warRoom/rootCauseEngine';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';

const URGENCY_STYLE = {
  OVERDUE:  { dot: 'bg-red-500 animate-pulse', ring: 'border-red-200 bg-red-50/50', badge: 'bg-red-100 text-red-700', label: '已逾期' },
  TODAY:    { dot: 'bg-yellow-400',            ring: 'border-yellow-200 bg-yellow-50/30', badge: 'bg-yellow-100 text-yellow-700', label: '今日截止' },
  UPCOMING: { dot: 'bg-blue-400',              ring: 'border-blue-100 bg-white',       badge: 'bg-blue-100 text-blue-600', label: '48h内' },
};

export default async function MyTodayPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { role, isAdmin } = await getCurrentUserRole(supabase);

  // Admin 跳转到 War Room
  if (isAdmin) redirect('/ceo-war-room');

  // 获取当前用户 profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, name, department')
    .eq('user_id', user.id)
    .maybeSingle();

  const displayName = (profile as any)?.full_name || (profile as any)?.name || user.email?.split('@')[0] || '你';

  // ── 获取该用户角色相关的里程碑 ──────────────────────────────
  const { data: myMilestones } = await supabase
    .from('milestones')
    .select(`
      id, step_key, name, owner_role, owner_user_id,
      due_at, status, is_critical, evidence_required, evidence_note,
      order_id, sequence_number
    `)
    .eq('owner_role', role)
    .neq('status', '已完成')
    .order('due_at', { ascending: true });

  // 获取相关订单信息
  const orderIds = [...new Set((myMilestones || []).map((m: any) => m.order_id))];
  const ordersMap: Record<string, { order_no: string; customer_name: string }> = {};

  if (orderIds.length > 0) {
    const { data: orders } = await supabase
      .from('orders')
      .select('id, order_no, customer_name')
      .in('id', orderIds);
    for (const o of (orders || []) as any[]) {
      ordersMap[o.id] = { order_no: o.order_no, customer_name: o.customer_name };
    }
  }

  // ── 获取 War Room 根因节点（联动）────────────────────────────
  let warRoomRootNodes: string[] = [];
  try {
    const { data: allOrders } = await supabase
      .from('orders')
      .select('id, order_no, customer_name, incoterm, etd, eta, warehouse_due_date, cancel_date, order_type');

    const ordersWithMs: any[] = [];
    for (const o of (allOrders || []) as any[]) {
      const { data: ms } = await supabase
        .from('milestones')
        .select('id, step_key, name, owner_role, owner_user_id, due_at, status, is_critical, sequence_number')
        .eq('order_id', o.id);
      ordersWithMs.push({ ...o, milestones: ms || [] });
    }

    const warRoomData = analyzeWarRoom(ordersWithMs);
    warRoomRootNodes = warRoomData
      .flatMap(wr => wr.chainDelay ? [wr.chainDelay.rootNode] : [])
      .filter(Boolean);
  } catch (_) {
    // War Room 数据获取失败不影响主功能
  }

  // 构建执行任务
  const tasks = buildExecutionTasks(myMilestones || [], ordersMap, warRoomRootNodes);
  const stats = summarizeExecutionTasks(tasks);

  const criticalTasks  = tasks.filter(t => t.urgency === 'OVERDUE' || (t.urgency === 'TODAY' && t.isCritical));
  const upcomingTasks  = tasks.filter(t => !criticalTasks.includes(t));

  // 我的订单（简洁列表）
  const myOrderList = Object.entries(ordersMap).slice(0, 8);

  // ── 明日提醒：24-48h 内到期的里程碑 ──────────────────────────
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const twoDaysLater = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const { data: tomorrowMilestones } = await (supabase.from('milestones') as any)
    .select('id, order_id, name, due_at, status, orders!inner(id, order_no, customer_name)')
    .gte('due_at', tomorrow.toISOString())
    .lt('due_at', twoDaysLater.toISOString())
    .neq('status', '已完成')
    .eq('owner_role', role)
    .order('due_at', { ascending: true });

  // ── 备忘摘要 ──────────────────────────────────────────────
  const { data: myMemos } = await (supabase.from('user_memos') as any)
    .select('id, content, remind_at, is_done')
    .eq('user_id', user.id)
    .eq('is_done', false)
    .order('created_at', { ascending: false })
    .limit(5);

  const activeMemoCount = (myMemos || []).length;
  const dueReminders = (myMemos || []).filter((m: any) => m.remind_at && new Date(m.remind_at) <= now);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-7 space-y-6">

        {/* 头部问候 */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">你好，{displayName} 👋</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {ROLE_LABEL[role] || role} ·{' '}
              {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}
            </p>
          </div>
          {stats.warRoomLinked > 0 && (
            <Link href="/ceo-war-room" className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 px-3 py-1.5 rounded-full hover:bg-red-100 transition-colors">
              <span>⚔️</span> War Room 关联 {stats.warRoomLinked} 项
            </Link>
          )}
        </div>

        {/* 状态概览 */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: '需立即处理', value: stats.overdue, color: stats.overdue > 0 ? 'text-red-600' : 'text-gray-400', bg: stats.overdue > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200' },
            { label: '今日截止',   value: stats.today,   color: stats.today > 0 ? 'text-yellow-600' : 'text-gray-400', bg: stats.today > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-white border-gray-200' },
            { label: '48h内到期', value: stats.upcoming, color: 'text-blue-500', bg: 'bg-white border-gray-200' },
          ].map(s => (
            <div key={s.label} className={`rounded-xl border px-4 py-3 ${s.bg}`}>
              <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* 全部完成状态 */}
        {tasks.length === 0 && (
          <div className="rounded-2xl border border-green-200 bg-green-50 p-10 text-center">
            <p className="text-4xl mb-3">✅</p>
            <p className="font-semibold text-green-800">今日任务全部完成！</p>
            <p className="text-sm text-green-600 mt-1">暂无需要处理的执行节点</p>
            <Link href="/orders" className="mt-4 inline-block text-sm text-indigo-600 hover:underline">查看我的订单 →</Link>
          </div>
        )}

        {/* 关键任务（必须今日处理） */}
        {criticalTasks.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-semibold text-red-700">🔴 必须今日处理</span>
              <span className="text-xs text-red-500 bg-red-100 px-2 py-0.5 rounded-full">{criticalTasks.length} 项</span>
            </div>
            <div className="space-y-3">
              {criticalTasks.map(task => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </section>
        )}

        {/* 即将到期 */}
        {upcomingTasks.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-semibold text-gray-700">🔔 即将到期（48小时内）</span>
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{upcomingTasks.length} 项</span>
            </div>
            <div className="space-y-3">
              {upcomingTasks.map(task => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </section>
        )}

        {/* 明日提醒 */}
        {tomorrowMilestones && tomorrowMilestones.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-semibold text-teal-700">🗓️ 明日提醒</span>
              <span className="text-xs text-teal-600 bg-teal-100 px-2 py-0.5 rounded-full">{tomorrowMilestones.length} 项</span>
            </div>
            <div className="rounded-xl border border-teal-200 bg-teal-50/30 divide-y divide-teal-100 overflow-hidden">
              {(tomorrowMilestones as any[]).map((m: any) => (
                <Link
                  key={m.id}
                  href={`/orders/${m.order_id}?tab=progress#milestone-${m.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-teal-50 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900">{m.name}</span>
                    <span className="text-xs text-gray-400 ml-2">{m.orders?.order_no} · {m.orders?.customer_name}</span>
                  </div>
                  <span className="text-xs text-teal-600 flex-shrink-0">
                    到期: {formatDate(m.due_at)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* 备忘提醒 */}
        {(dueReminders.length > 0 || activeMemoCount > 0) && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-700">📝 备忘录</span>
                {dueReminders.length > 0 && (
                  <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">🔔 {dueReminders.length} 条提醒到期</span>
                )}
              </div>
              <Link href="/memos" className="text-xs text-indigo-600 hover:underline">管理全部 →</Link>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
              {dueReminders.map((m: any) => (
                <div key={m.id} className="flex items-center gap-2 text-sm">
                  <span className="text-amber-500">🔔</span>
                  <span className="text-gray-900">{m.content}</span>
                </div>
              ))}
              {activeMemoCount > dueReminders.length && (
                <p className="text-xs text-gray-400">
                  还有 {activeMemoCount - dueReminders.length} 条待办备忘
                </p>
              )}
            </div>
          </section>
        )}

        {/* 我的订单 */}
        {myOrderList.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-gray-700">📦 我的订单</span>
              <Link href="/orders" className="text-xs text-indigo-600 hover:underline">查看全部 →</Link>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100 overflow-hidden">
              {myOrderList.map(([orderId, order]) => (
                <Link key={orderId} href={`/orders/${orderId}?tab=progress`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors group">
                  <div>
                    <span className="text-sm font-medium text-gray-900">{order.order_no}</span>
                    <span className="text-xs text-gray-400 ml-2">{order.customer_name}</span>
                  </div>
                  <span className="text-xs text-gray-400 group-hover:text-indigo-600">→</span>
                </Link>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  );
}

function TaskCard({ task }: { task: any }) {
  const style = URGENCY_STYLE[task.urgency as keyof typeof URGENCY_STYLE];
  const orderHref = `/orders/${task.orderId}?tab=progress`;

  return (
    <div className={`rounded-xl border ${style.ring} p-4`}>
      {/* 任务头 */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-gray-900">{task.milestoneName}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style.badge}`}>{style.label}</span>
              {task.isCritical && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">关键</span>
              )}
              {task.warRoomTag && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">{task.warRoomTag}</span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {task.orderNo} · {task.customerName}
              {task.dueAt && ` · 截止 ${formatDate(task.dueAt)}`}
            </p>
          </div>
        </div>
      </div>

      {/* 系统建议 */}
      {task.suggestion && (
        <div className="text-xs text-gray-600 bg-white border border-gray-200 rounded-lg px-3 py-2 mb-3 leading-relaxed">
          {task.suggestion}
        </div>
      )}

      {/* 操作按钮：只有「去处理」和「申请延期」，无手动完成 */}
      <div className="flex items-center gap-2">
        <Link href={orderHref}
          className="flex-1 text-center py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs text-white font-semibold transition-colors">
          📤 去处理
        </Link>
        <Link href={`${orderHref}#delay`}
          className="px-4 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-xs text-gray-600 font-medium transition-colors">
          申请延期
        </Link>
      </div>
    </div>
  );
}
