import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FactoryScheduleBoard } from '@/components/production/FactoryScheduleBoard';
import { requireProductionPage } from '@/lib/utils/production-page-guard';

export const dynamic = 'force-dynamic';

export default async function FactorySchedulePage() {
  const { roles } = await requireProductionPage();
  if (!roles.some((role) => ['admin', 'production_manager'].includes(role))) redirect('/production');
  return <main className="mx-auto max-w-[1440px] px-3 py-4 sm:px-5"><div className="mb-4 flex items-center justify-between"><div><h1 className="text-2xl font-bold text-slate-900">工厂排产看板</h1><p className="text-sm text-slate-500">工厂负荷、产能冲突与派工计划</p></div><Link href="/production" className="text-sm text-indigo-600 hover:underline">← 返回生产中心</Link></div><FactoryScheduleBoard /></main>;
}
