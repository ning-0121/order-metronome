import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SchedulingBoard } from '@/components/production/SchedulingBoard';
import { ProductionGanttChart } from '@/components/production/ProductionGanttChart';
import { CollapsibleSection } from '@/components/CollapsibleSection';
import { getProductionCenter } from '@/app/actions/production-center';
import { requireProductionPage } from '@/lib/utils/production-page-guard';

export const dynamic = 'force-dynamic';

export default async function ProductionSchedulingPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const params = await searchParams;
  const { roles } = await requireProductionPage();
  if (!roles.some((role) => ['admin', 'production_manager'].includes(role))) redirect('/production');
  const result = await getProductionCenter();
  return <main className="mx-auto max-w-[1440px] px-3 py-4 sm:px-5"><div className="mb-4 flex items-center justify-between"><div><h1 className="text-2xl font-bold text-slate-900">排单与派单工作台</h1><p className="text-sm text-slate-500">生产计划排产与工单派发</p></div><Link href="/production" className="text-sm text-indigo-600 hover:underline">← 返回生产中心</Link></div><SchedulingBoard initialSearch={params.q || ''} /><div className="mt-4"><CollapsibleSection title="排产甘特图" subtitle="工厂×时间·可视化进度" defaultOpen={false}><ProductionGanttChart rows={result.data || []} /></CollapsibleSection></div></main>;
}
