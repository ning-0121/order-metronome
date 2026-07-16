import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ProductionProgressBoard } from '@/components/production/ProductionProgressBoard';
import { requireProductionPage } from '@/lib/utils/production-page-guard';

export const dynamic = 'force-dynamic';

export default async function ProductionProgressPage() {
  const { roles } = await requireProductionPage();
  if (!roles.some((role) => ['admin', 'production_manager', 'production', 'qc', 'quality'].includes(role))) redirect('/production');
  const canManage = roles.some((role) => ['admin', 'production_manager'].includes(role));
  return <main className="mx-auto max-w-[1440px] px-3 py-4 sm:px-5"><div className="mb-4 flex items-center justify-between"><div><h1 className="text-2xl font-bold text-slate-900">生产进度录入</h1><p className="text-sm text-slate-500">生产进度更新、报工与交期预警</p></div><Link href="/production" className="text-sm text-indigo-600 hover:underline">← 返回生产中心</Link></div><ProductionProgressBoard canManage={canManage} /></main>;
}
