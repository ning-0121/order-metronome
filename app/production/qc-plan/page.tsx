import Link from 'next/link';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getQcInspectionPlan } from '@/app/actions/qc-inspection-plan';
import { QcPlanClient } from './QcPlanClient';

export const dynamic = 'force-dynamic';

export default async function QcInspectionPlanPage() {
  await requireProductionPage();
  const res = await getQcInspectionPlan();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4">
        <Link href="/production" className="text-sm text-indigo-600 hover:underline">← 返回生产中心</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">🔍 QC 巡查计划</h1>
        <p className="text-sm text-gray-500 mt-1">
          跨所有订单,列出待验货的节点(中检 / 尾检 / 放行),按工厂和日期排好 —— 按这个安排去哪个厂、先验哪张单。
        </p>
      </div>
      {res.error ? (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{res.error}</p>
      ) : (
        <QcPlanClient groups={res.groups || []} summary={res.summary!} />
      )}
    </div>
  );
}
