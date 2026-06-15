import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getProcurementQueues } from '@/app/actions/procurement';
import { ProcurementQueueClient } from '@/components/ProcurementQueueClient';

/**
 * 采购中心（Procurement Center）V1 — 工作队列页。
 * 三队列：待下单 / 待催货 / 待验收（跨订单聚合，订单是主线）。
 * 数据/权限由 getProcurementQueues 把关（ALLOWED_ROLES 可看；写操作 action 内再校验采购/管理员）。
 */
export default async function ProcurementCenterPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const result = await getProcurementQueues();
  if (result.error) {
    // 无权限或查询失败：降级提示，不 crash
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <h1 className="text-xl font-bold text-gray-900 mb-2">采购中心</h1>
        <p>{result.error}</p>
      </div>
    );
  }

  const { pendingOrder, chase, receive, counts } = result.data!;

  const Stat = ({ label, value, tone }: { label: string; value: number; tone: string }) => (
    <div className={`rounded-xl border px-4 py-3 ${tone}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-0.5 opacity-80">{label}</div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🛒 采购中心</h1>
        <p className="mt-1 text-sm text-gray-500">订单是主线 · 待下单 / 待催货 / 待验收</p>
      </div>

      {/* Dashboard 壳：四个计数 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="待下单" value={counts.pendingOrder} tone="border-indigo-200 bg-indigo-50 text-indigo-800" />
        <Stat label="待催货 / 在途" value={counts.chase} tone="border-amber-200 bg-amber-50 text-amber-800" />
        <Stat label="待验收" value={counts.receive} tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
        <Stat label="🔴 红灯行" value={counts.red} tone="border-red-200 bg-red-50 text-red-800" />
      </div>

      <ProcurementQueueClient pendingOrder={pendingOrder} chase={chase} receive={receive} />
    </div>
  );
}
