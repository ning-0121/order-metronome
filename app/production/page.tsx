import Link from 'next/link';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getProductionCenter } from '@/app/actions/production-center';
import { isStageInitOpen } from '@/app/actions/production-stage-init';
import { ProductionCenterClient } from './ProductionCenterClient';
import { ReconcileExportButton } from './ReconcileExportButton';
import { SchedulingBoard } from '@/components/production/SchedulingBoard';
import { FactoryScheduleBoard } from '@/components/production/FactoryScheduleBoard';
import { ProductionProgressBoard } from '@/components/production/ProductionProgressBoard';
import { ProductionGanttChart } from '@/components/production/ProductionGanttChart';
import { CollapsibleSection } from '@/components/CollapsibleSection';
import { buildProductionDashboard, type DashboardRole } from '@/lib/production/dashboard';

export const dynamic = 'force-dynamic';

export default async function ProductionCenterPage({ searchParams }: { searchParams: Promise<{ workspace?: string; detail?: string; stage?: string; q?: string }> }) {
  const params = await searchParams;
  const { roles } = await requireProductionPage();
  const result = await getProductionCenter();
  const canManage = roles.includes('admin') || roles.includes('production_manager');
  const canLogProgress = canManage || roles.includes('production') || roles.includes('qc') || roles.includes('quality');
  const showInit = canManage && (await isStageInitOpen());

  if (result.error) return <div className="mx-auto max-w-3xl px-4 py-12 text-center"><h1 className="text-xl font-bold">生产中心</h1><p className="mt-2 text-gray-500">{result.error}</p></div>;

  const rows = result.data || [];
  const summary = result.summary || { total: 0, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 0, in_production: 0, ready_to_ship: 0, risk: 0, completed: 0 };
  const role: DashboardRole = roles.some((item) => ['admin', 'order_manager'].includes(item)) ? 'executive'
    : roles.some((item) => ['qc', 'quality'].includes(item)) ? 'qc'
    : canManage ? 'supervisor' : 'follow_up';
  const dashboard = buildProductionDashboard(rows, summary, role);
  const initialDetail = params.q || params.detail || '';
  const updatedAt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date());

  return (
    <main className="mx-auto max-w-[1440px] px-3 py-4 sm:px-5">
      <header className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 lg:w-72"><h1 className="text-xl font-bold text-gray-900">生产中心</h1><p className="truncate text-xs text-gray-500">生产进度总览与任务协同执行中心</p></div>
        <form action="/production" className="flex min-w-0 flex-1"><label htmlFor="production-search" className="sr-only">搜索生产订单</label><input id="production-search" name="q" defaultValue={params.q || ''} placeholder="订单、PO、款号、客户" className="w-full rounded-l-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" /><button className="rounded-r-lg bg-indigo-600 px-3 text-sm text-white hover:bg-indigo-700">搜索</button></form>
        <div className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
          {showInit && <Link href="/production/stage-init" className="rounded-lg border border-gray-200 px-2.5 py-1.5 hover:bg-gray-50">设置 / 初始化</Link>}
          <span>最后更新 {updatedAt}</span><Link href="/production" className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-indigo-600 hover:bg-indigo-50">刷新</Link><ReconcileExportButton />
        </div>
      </header>

      <ProductionCenterClient summary={summary} dashboard={dashboard} canManage={canManage} initialDetail={initialDetail} initialStage={params.stage || ''} />

      <section className="mt-4 space-y-3" aria-label="生产工作台">
        {canLogProgress && params.workspace === 'gantt' && <div id="gantt"><CollapsibleSection title="📊 排产甘特图" subtitle="工厂×时间·可视化进度"><ProductionGanttChart rows={rows} /></CollapsibleSection></div>}
        {canManage && <div id="scheduling"><CollapsibleSection title="🏭 排单与派单工作台" subtitle="把款派给工厂" defaultOpen={params.workspace === 'scheduling'}><SchedulingBoard /></CollapsibleSection></div>}
        {canManage && <div id="factory"><CollapsibleSection title="🏭 工厂排产看板" subtitle="按工厂看负荷与派工" defaultOpen={params.workspace === 'factory'}><FactoryScheduleBoard /></CollapsibleSection></div>}
        {canLogProgress && <div id="progress"><CollapsibleSection title="📈 生产进度录入" subtitle="跟单/QC 录实绩" defaultOpen={params.workspace === 'progress'}><ProductionProgressBoard canManage={canManage} /></CollapsibleSection></div>}
      </section>
      <p className="mt-3 text-[11px] text-gray-400">阶段为现有订单、采购物料与生产节点的只读派生结果；详细任务仅在展开或导航后加载，不在首页渲染完整队列。</p>
    </main>
  );
}
