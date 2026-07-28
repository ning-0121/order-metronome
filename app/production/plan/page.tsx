import Link from 'next/link';
import { getFollowUpPlan, type PlanNode } from '@/app/actions/follow-up-plan';

export const dynamic = 'force-dynamic';

/**
 * 跟单计划(2026-07-27 CEO):屏幕版日程,手机可读。「我负责的订单 × 还差哪些节点 × 各节点日期」,
 * 按 逾期/今天/本周/以后/未排期 分组,点节点直达订单进度去做。周日程导出的在线孪生。
 */

const BUCKETS: Array<{ key: keyof ReturnType<typeof emptyBuckets>; label: string; emoji: string; ring: string; head: string }> = [
  { key: 'overdue', label: '逾期', emoji: '🔴', ring: 'border-red-200', head: 'text-red-700' },
  { key: 'today', label: '今天', emoji: '🟠', ring: 'border-orange-200', head: 'text-orange-700' },
  { key: 'week', label: '本周内', emoji: '🟡', ring: 'border-amber-200', head: 'text-amber-700' },
  { key: 'later', label: '以后', emoji: '⚪', ring: 'border-gray-200', head: 'text-gray-600' },
  { key: 'undated', label: '未排期', emoji: '🗓', ring: 'border-gray-200', head: 'text-gray-500' },
];
function emptyBuckets() { return { overdue: [], today: [], week: [], later: [], undated: [] } as Record<string, PlanNode[]>; }

function NodeCard({ n }: { n: PlanNode }) {
  return (
    <Link href={`/orders/${n.orderId}?tab=progress`}
      className="block rounded-xl border border-gray-200 bg-white p-3 active:scale-[0.99] hover:border-indigo-300 transition">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-gray-900 text-sm">{n.nodeName}</span>
            {n.isCritical && <span className="text-[10px] px-1 py-0.5 rounded bg-red-50 text-red-600 border border-red-100">关键</span>}
            <span className="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-500">{n.stage}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1 truncate">{n.orderNo} · {n.customer}{n.factory ? ` · ${n.factory}` : ''}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-xs font-medium whitespace-nowrap ${n.bucket === 'overdue' ? 'text-red-600' : n.bucket === 'today' ? 'text-orange-600' : 'text-gray-600'}`}>
            {n.dueLabel}
          </div>
          {n.overdueDays > 0 && <div className="text-[11px] text-red-500">逾期{n.overdueDays}天</div>}
          <div className="text-[11px] text-gray-400 mt-0.5">{n.status}</div>
        </div>
      </div>
    </Link>
  );
}

export default async function FollowUpPlanPage({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const { owner } = await searchParams;
  const plan = await getFollowUpPlan(owner);

  if (plan.error) {
    return <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">{plan.error}</div>;
  }

  const title = plan.self ? '我的跟单计划' : `${plan.ownerName || '跟单'} 的计划`;

  return (
    <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
      <div className="mb-1 flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">🗓️ {title}</h1>
        <Link href="/production" className="text-sm text-indigo-600 hover:underline">← 生产中心</Link>
      </div>
      <p className="text-sm text-gray-500 mb-3">
        你负责的订单还差哪些节点、各节点到期日。点任一节点直达订单进度去处理。
        共 <b className="text-gray-700">{plan.counts.total}</b> 个待办节点
        {plan.counts.overdue > 0 && <>(<b className="text-red-600">{plan.counts.overdue} 逾期</b>)</>}。
      </p>

      {/* 管理层:切换跟单人 */}
      {plan.people && plan.people.length > 0 && (
        <div className="mb-4 flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-gray-400">查看:</span>
          <Link href="/production/plan"
            className={`px-2 py-1 rounded-full border ${plan.self ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>我自己</Link>
          {plan.people.map((p) => (
            <Link key={p.user_id} href={`/production/plan?owner=${p.user_id}`}
              className={`px-2 py-1 rounded-full border ${owner === p.user_id ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {p.name}
            </Link>
          ))}
        </div>
      )}

      {plan.counts.total === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-gray-400">
          ✅ 暂无待办节点。新节点到期会自动出现在这里。
        </div>
      ) : (
        <div className="space-y-5">
          {BUCKETS.map(({ key, label, emoji, head }) => {
            const items = (plan.buckets as any)[key] as PlanNode[];
            if (!items || items.length === 0) return null;
            return (
              <section key={key}>
                <h2 className={`mb-2 text-sm font-semibold ${head}`}>{emoji} {label} · {items.length}</h2>
                <div className="grid gap-2 sm:grid-cols-2">
                  {items.map((n, i) => <NodeCard key={`${n.orderId}-${n.stepKey}-${i}`} n={n} />)}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
