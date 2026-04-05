import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { QuoteApproval } from '@/components/QuoteApproval';
import { CreateSampleButton } from '@/components/CreateSampleButton';

export default async function QuotesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin, role } = await getCurrentUserRole(supabase);

  // 获取所有订单的报价信息
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_name, quantity, incoterm, order_type, quote_status, quote_approved_by, quote_approved_at, unit_price, currency, total_amount, created_at, created_by, lifecycle_status')
    .order('created_at', { ascending: false });

  // 获取审批人名称
  const approverIds = [...new Set((orders || []).map((o: any) => o.quote_approved_by).filter(Boolean))];
  let approverMap: Record<string, string> = {};
  if (approverIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email').in('user_id', approverIds);
    approverMap = (profiles || []).reduce((m: any, p: any) => {
      m[p.user_id] = p.name || p.email?.split('@')[0];
      return m;
    }, {});
  }

  const allOrders = orders || [];
  const pending = allOrders.filter((o: any) => o.quote_status === 'pending');
  const approved = allOrders.filter((o: any) => o.quote_status === 'approved');
  const rejected = allOrders.filter((o: any) => o.quote_status === 'rejected');

  const incotermLabels: Record<string, string> = {
    FOB: 'FOB', DDP: 'DDP', RMB_EX_TAX: '人民币不含税', RMB_INC_TAX: '人民币含税',
  };
  const typeLabels: Record<string, string> = {
    trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品',
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">报价管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            待审批 {pending.length} · 已通过 {approved.length} · 已驳回 {rejected.length}
          </p>
        </div>
        <Link href="/quotes/new" className="btn-primary inline-flex items-center gap-2">
          + 新建报价单
        </Link>
      </div>

      {/* 报价管线概览 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-4 text-center">
          <div className="text-3xl font-bold text-amber-700">{pending.length}</div>
          <div className="text-sm text-amber-600 mt-1">待审批</div>
        </div>
        <div className="bg-green-50 rounded-xl border border-green-200 p-4 text-center">
          <div className="text-3xl font-bold text-green-700">{approved.length}</div>
          <div className="text-sm text-green-600 mt-1">已通过</div>
        </div>
        <div className="bg-red-50 rounded-xl border border-red-200 p-4 text-center">
          <div className="text-3xl font-bold text-red-700">{rejected.length}</div>
          <div className="text-sm text-red-600 mt-1">已驳回</div>
        </div>
      </div>

      {/* 待审批列表 */}
      {pending.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 shadow-sm overflow-hidden mb-6">
          <div className="bg-amber-50 px-5 py-3 border-b border-amber-100">
            <h2 className="font-bold text-amber-900">⏳ 待审批报价（{pending.length}）</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {pending.map((o: any) => (
              <div key={o.id} className="px-5 py-4 flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <Link href={`/orders/${o.id}`} className="font-semibold text-indigo-600 hover:underline">{o.order_no}</Link>
                    <span className="text-sm text-gray-600">{o.customer_name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{incotermLabels[o.incoterm] || o.incoterm}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{typeLabels[o.order_type] || o.order_type}</span>
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    {o.quantity ? `${o.quantity} 件` : ''}{o.factory_name ? ` · ${o.factory_name}` : ''} · {formatDate(o.created_at)}
                  </div>
                </div>
                <QuoteApproval orderId={o.id} quoteStatus={o.quote_status} canApprove={isAdmin} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已审批列表 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-5 py-3 border-b border-gray-200">
          <h2 className="font-bold text-gray-900">📋 全部报价记录</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-2.5 font-medium text-gray-600">订单号</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">客户</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">数量</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">条款</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">类型</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">报价状态</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">审批人</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">创建日期</th>
                <th className="px-4 py-2.5 font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {allOrders.map((o: any) => {
                const statusCfg: Record<string, { label: string; cls: string }> = {
                  pending: { label: '待审批', cls: 'bg-amber-100 text-amber-700' },
                  approved: { label: '已通过', cls: 'bg-green-100 text-green-700' },
                  rejected: { label: '已驳回', cls: 'bg-red-100 text-red-700' },
                };
                const st = statusCfg[o.quote_status] || statusCfg.pending;
                return (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <Link href={`/orders/${o.id}`} className="font-medium text-indigo-600 hover:underline">{o.order_no}</Link>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">{o.customer_name}</td>
                    <td className="px-4 py-2.5 text-gray-700">{o.quantity ? `${o.quantity}件` : '-'}</td>
                    <td className="px-4 py-2.5 text-gray-500">{incotermLabels[o.incoterm] || o.incoterm}</td>
                    <td className="px-4 py-2.5 text-gray-500">{typeLabels[o.order_type] || o.order_type}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">
                      {o.quote_approved_by ? approverMap[o.quote_approved_by] || '-' : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{formatDate(o.created_at)}</td>
                    <td className="px-4 py-2.5">
                      {o.quote_status === 'approved' && o.order_purpose !== 'sample' && (
                        <CreateSampleButton quoteOrderId={o.id} orderNo={o.order_no} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
