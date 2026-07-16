'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { getProductionDetailedTasks, type ProductionCenterSummary } from '@/app/actions/production-center';
import {
  PRODUCTION_QUICK_ENTRIES, STAGE_DEFINITIONS,
  type DashboardLink, type DetailedProductionTask,
} from '@/lib/production/dashboard';
import { QimoCommandGrid, QimoEmptyState, QimoKpiCard, QimoKpiGrid, QimoQuickEntryRow } from '@/components/qimo-v2/QimoDashboard';
import { FactoryIcon, ProgressIcon, ScheduleIcon, ShieldIcon } from '@/components/qimo-v2/icons';

type DashboardData = { today: DashboardLink[]; approvals: DashboardLink[]; risks: DashboardLink[]; detailedCount: number };

const KPI = [
  ['awaiting_procurement', '新订单待采购', '○', 'text-slate-700'],
  ['materials_in_transit', '物料在途', '→', 'text-sky-700'],
  ['ready_to_schedule', '开生产待排单', '□', 'text-emerald-700'],
  ['in_production', '生产中', '◇', 'text-indigo-700'],
  ['ready_to_ship', '待发货', '△', 'text-teal-700'],
  ['risk', '风险单', '!', 'text-rose-700'],
] as const;

function Empty({ text }: { text: string }) {
  return <QimoEmptyState>{text}</QimoEmptyState>;
}

function CommandPanel({ title, icon, items, allHref }: { title: string; icon: string; items: DashboardLink[]; allHref: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">{icon} {title}</h2>
        <Link href={allHref} className="text-xs text-indigo-600 hover:underline">查看全部</Link>
      </div>
      {items.length === 0 ? <Empty text="当前没有需要处理的事项" /> : (
        <div className="divide-y divide-gray-100">
          {items.slice(0, 5).map((item) => (
            <Link key={item.label} href={item.href} className="flex items-center gap-2 py-2 hover:bg-gray-50">
              <span className={`h-2 w-2 shrink-0 rounded-full ${item.severity === 'critical' ? 'bg-rose-500' : item.severity === 'high' ? 'bg-amber-400' : 'bg-indigo-400'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-gray-800">{item.label}</span>
                <span className="block truncate text-[11px] text-gray-500">{item.description}</span>
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-gray-700">{item.count}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function ProductionCenterClient({
  summary, dashboard, canManage, initialDetail = '', initialStage = '',
}: { summary: ProductionCenterSummary; dashboard: DashboardData; canManage: boolean; initialDetail?: string; initialStage?: string }) {
  const [open, setOpen] = useState(Boolean(initialDetail || initialStage));
  const [tasks, setTasks] = useState<DetailedProductionTask[]>([]);
  const [total, setTotal] = useState(dashboard.detailedCount);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  function load(reset = false) {
    startTransition(async () => {
      const offset = reset ? 0 : tasks.length;
      const result = await getProductionDetailedTasks({ offset, limit: 25, query: initialDetail === 'all' ? '' : initialDetail, stage: initialStage });
      if (result.error) { setError(result.error); return; }
      setTasks((current) => reset ? result.items : [...current, ...result.items]);
      setTotal(result.total); setHasMore(result.hasMore); setError('');
    });
  }

  useEffect(() => { if (initialDetail || initialStage) load(true); /* explicit navigation only */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTotal = summary.awaiting_procurement + summary.materials_in_transit + summary.ready_to_schedule + summary.in_production + summary.ready_to_ship;
  const flowTotal = activeTotal + summary.completed;
  const completionRate = flowTotal ? Math.round((summary.completed / flowTotal) * 100) : 0;
  const quickEntryIcons = [<ScheduleIcon key="schedule" className="h-4 w-4" />, <FactoryIcon key="factory" className="h-4 w-4" />, <ProgressIcon key="progress" className="h-4 w-4" />, <ShieldIcon key="risk" className="h-4 w-4" />];
  const quickEntries = PRODUCTION_QUICK_ENTRIES.map((entry, index) => ({ ...entry, icon: quickEntryIcons[index] }));

  return (
    <div className="space-y-4">
      <QimoQuickEntryRow entries={quickEntries} />

      <QimoKpiGrid>
        {KPI.map(([key, label, icon, tone]) => (
          <QimoKpiCard key={key} href={`/production?stage=${key}#details`} label={label} value={summary[key]} icon={<span className="text-sm font-semibold">{icon}</span>} tone={tone} />
        ))}
      </QimoKpiGrid>

      <section className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-gray-900">生产进度总览</h2><span className="text-xs text-gray-500">整体完成率 <b className="text-emerald-700">{completionRate}%</b></span></div>
        <div className="overflow-x-auto pb-1">
          <div className="flex min-w-[760px] items-stretch gap-1">
            {STAGE_DEFINITIONS.map(([key, label], index) => {
              const count = summary[key]; const share = flowTotal ? Math.round((count / flowTotal) * 100) : 0;
              return <div key={key} className="flex flex-1 items-center"><Link href={key === 'completed' ? '/orders?status=completed' : `/production?stage=${key}#details`} className="w-full rounded-lg border border-gray-100 bg-gray-50 px-2 py-2 text-center hover:border-indigo-300 hover:bg-indigo-50"><span className="block text-lg font-bold tabular-nums text-gray-900">{count}</span><span className="block text-[11px] text-gray-600">{label}</span><span className="block text-[10px] text-gray-400">{share}%</span></Link>{index < STAGE_DEFINITIONS.length - 1 && <span className="px-1 text-gray-300">→</span>}</div>;
            })}
          </div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${completionRate}%` }} /></div>
      </section>

      <QimoCommandGrid>
        <CommandPanel title="今日待办事项" icon="·" items={dashboard.today} allHref="/production?detail=all#details" />
        <CommandPanel title="协作 / 审批提示" icon="·" items={dashboard.approvals} allHref={canManage ? '/production?detail=延期待审批#details' : '/production?detail=all#details'} />
        <CommandPanel title="风险干预预警" icon="·" items={dashboard.risks} allHref="/production?detail=已超期#details" />
      </QimoCommandGrid>

      <section id="details" className="rounded-xl border border-gray-200 bg-white">
        <button type="button" onClick={() => { const next = !open; setOpen(next); if (next && tasks.length === 0) load(true); }} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-gray-50" aria-expanded={open}>
          <span className={`text-xs text-gray-400 transition ${open ? 'rotate-90' : ''}`}>▶</span><span className="text-sm font-semibold text-gray-900">生产主管详细任务（{total}）</span><span className="ml-auto text-xs text-indigo-600">{open ? '收起' : '展开'}</span>
        </button>
        {open && <div className="border-t border-gray-100 p-3">
          {pending && tasks.length === 0 ? <Empty text="正在加载详细任务…" /> : error ? <Empty text={error} /> : tasks.length === 0 ? <Empty text="当前没有详细任务" /> : <div className="divide-y divide-gray-100">{tasks.map((task) => <Link key={task.key} href={task.href} className="flex items-start gap-3 px-2 py-2 hover:bg-gray-50"><span className={`mt-1 h-2 w-2 rounded-full ${task.urgent ? 'bg-rose-500' : 'bg-indigo-400'}`} /><span className="min-w-0 flex-1"><span className="text-xs font-semibold text-gray-900">{task.orderNo} · {task.customerName}</span><span className="ml-2 text-xs text-gray-600">{task.title}</span><span className="block truncate text-[11px] text-gray-500">{task.reasons.join('；')} · 下一步：{task.action}</span><span className="mt-1 flex gap-1">{task.badges.map((badge) => <span key={badge} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{badge}</span>)}</span></span><span className="text-xs text-indigo-600">处理 ›</span></Link>)}</div>}
          {hasMore && <button type="button" disabled={pending} onClick={() => load(false)} className="mt-3 w-full rounded-lg border border-gray-200 py-2 text-xs text-indigo-600 hover:bg-gray-50 disabled:opacity-50">{pending ? '加载中…' : '加载更多'}</button>}
        </div>}
      </section>
    </div>
  );
}
