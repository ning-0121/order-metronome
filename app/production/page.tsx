import Link from 'next/link';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getProductionCenter } from '@/app/actions/production-center';
import { isStageInitOpen } from '@/app/actions/production-stage-init';
import { ProductionCenterClient } from './ProductionCenterClient';
import { ReconcileExportButton } from './ReconcileExportButton';
import { buildProductionDashboard, type DashboardRole } from '@/lib/production/dashboard';
import { createClient } from '@/lib/supabase/server';
import { loadUserProductionTodayTasks } from '@/lib/production/today-tasks';

export const dynamic = 'force-dynamic';

export default async function ProductionCenterPage({ searchParams }: { searchParams: Promise<{ detail?: string; stage?: string; q?: string }> }) {
  const params = await searchParams;
  const { roles } = await requireProductionPage();
  const result = await getProductionCenter();
  const canManage = roles.includes('admin') || roles.includes('production_manager');
  const showInit = canManage && (await isStageInitOpen());

  if (result.error) return <div className="mx-auto max-w-3xl px-4 py-12 text-center"><h1 className="text-xl font-bold">生产中心</h1><p className="mt-2 text-gray-500">{result.error}</p></div>;

  const rows = result.data || [];
  const summary = result.summary || { total: 0, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 0, in_production: 0, ready_to_ship: 0, risk: 0, completed: 0 };
  const role: DashboardRole = roles.some((item) => ['admin', 'order_manager'].includes(item)) ? 'executive'
    : roles.some((item) => ['qc', 'quality'].includes(item)) ? 'qc'
    : canManage ? 'supervisor' : 'follow_up';
  const dashboard = buildProductionDashboard(rows, summary, role);
  const supa = await createClient();
  const { data: { user } } = await supa.auth.getUser();
  const todayTasks = user ? await loadUserProductionTodayTasks(supa, user.id) : [];
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

      {/* 我的今日待办 —— 生产跟单该干的活(催料/排厂/首日/中查/尾查/包装/追踪问题) */}
      <section className="mb-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-indigo-900">🗓️ 我的今日待办{todayTasks.length > 0 ? ` · ${todayTasks.length}` : ''}</h2>
          <Link href="/my-today" className="text-xs text-indigo-600 hover:underline">全部今日任务 →</Link>
        </div>
        {todayTasks.length === 0 ? (
          <p className="text-xs text-gray-500">今日暂无生产待办 ✅（催料 / 排厂 / 首日上线 / 中查 / 尾查 / 包装 / 追踪问题到点会自动出现在这里）</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {todayTasks.slice(0, 8).map((t: any) => (
              <li key={t.id}>
                <Link href={t.action_url || '#'} className="flex items-center gap-2 rounded-lg border border-indigo-100 bg-white px-3 py-2 text-xs hover:bg-indigo-50">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.priority === 1 ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <span className="truncate text-gray-800">{t.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProductionCenterClient summary={summary} dashboard={dashboard} canManage={canManage} role={role} initialDetail={initialDetail} initialStage={params.stage || ''} />

    </main>
  );
}
