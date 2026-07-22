import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { ProductionProgressTab } from '@/components/tabs/ProductionProgressTab';
import { ProductionIssuesPanel } from '@/components/production/ProductionIssuesPanel';

/**
 * 生产中心 · 单订单生产节点(2026-07-06 用户拍板:生产/QC 在生产中心走节点,不进完整订单详情)。
 * 业务在订单详情「生产进度」只读看进度;生产/QC 在这里走节点、传报告。
 */
export default async function ProductionOrderNodePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { roles } = await requireProductionPage(['qc']);   // 生产/生产经理/理单/QC/管理员;非生产回工作台
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, lifecycle_status')
    .eq('id', id).maybeSingle();
  if (!order) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <p className="mb-3">订单不存在</p>
        <Link href="/production" className="text-indigo-600 hover:underline">← 生产中心</Link>
      </div>
    );
  }

  const isAdmin = roles.includes('admin');
  // 生产/生产经理/QC/管理员 可走节点、传报告
  const canReport = roles.some((r) => ['production', 'production_manager', 'qc', 'admin'].includes(r));

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-2"><Link href="/production" className="text-sm text-gray-500 hover:text-indigo-600">← 生产中心</Link></div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900">
          🏭 {(order as any).internal_order_no || (order as any).order_no} · 生产节点
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {(order as any).customer_name || '—'} · {(order as any).quantity ?? '—'} 件 · 工厂 {(order as any).factory_name || '未指定'}
          {(order as any).factory_date ? ` · 工厂期 ${String((order as any).factory_date).slice(0, 10)}` : ''}
        </p>
        <p className="text-xs text-gray-400 mt-1">生产/QC 在此走节点、传报告;业务在订单「生产进度」只读看进度。</p>
      </div>
      <ProductionProgressTab orderId={id} orderNo={(order as any).order_no || ''} isAdmin={isAdmin} canReport={canReport} />
      <ProductionIssuesPanel orderId={id} canWrite={canReport} />
    </div>
  );
}
