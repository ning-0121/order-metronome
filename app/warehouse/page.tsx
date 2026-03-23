import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';

export default async function WarehousePage() {
  // V1 收敛：仓库工作台暂时隐藏，员工统一使用 /dashboard
  redirect('/dashboard');

  // ── 以下代码保留但不再可达 ──
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { role, isAdmin } = await getCurrentUserRole(supabase);
  if (role !== 'logistics' && !isAdmin) redirect('/dashboard');

  const { data: pendingPacking } = await (supabase as any)
    .from('packing_lists')
    .select('*, orders(order_no, customer_name, quantity)')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });

  const { data: pendingShipment } = await (supabase as any)
    .from('shipment_confirmations')
    .select('*, orders(order_no, customer_name)')
    .neq('status', 'locked')
    .neq('status', 'fully_signed')
    .order('created_at', { ascending: false });

  const { data: pendingIssue } = await (supabase as any)
    .from('issue_slips')
    .select('*, orders(order_no, customer_name)')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });

  const stats = [
    { label: '待确认装箱单', value: pendingPacking?.length || 0, color: 'text-blue-600', href: '#packing' },
    { label: '待签核出货', value: pendingShipment?.length || 0, color: 'text-orange-600', href: '#shipment' },
    { label: '待确认发料单', value: pendingIssue?.length || 0, color: 'text-purple-600', href: '#issue' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">仓库工作台</h1>
          <p className="text-sm text-gray-500 mt-1">发料 · 回收 · 装箱 · 出货签核</p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-8">
        {/* 统计卡片 */}
        <div className="grid grid-cols-3 gap-4">
          {stats.map(({ label, value, color, href }) => (
            <a key={label} href={href}
              className="bg-white rounded-xl border border-gray-200 p-5 hover:border-indigo-300 transition-colors">
              <div className={`text-3xl font-bold ${color} mb-1`}>{value}</div>
              <div className="text-sm text-gray-500">{label}</div>
            </a>
          ))}
        </div>

        {/* 待确认装箱单 */}
        <div id="packing" className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">待确认装箱单</h2>
          {!pendingPacking?.length ? (
            <p className="text-gray-400 text-sm text-center py-4">暂无待处理</p>
          ) : (
            <div className="space-y-3">
              {(pendingPacking as any[]).map((pl: any) => (
                <div key={pl.id} className="flex items-center justify-between p-4 rounded-xl bg-blue-50">
                  <div>
                    <span className="font-medium text-gray-900">{pl.orders?.order_no}</span>
                    <span className="ml-2 text-sm text-gray-500">{pl.orders?.customer_name}</span>
                    <span className="ml-3 text-xs text-gray-400">总件数：{pl.total_qty}</span>
                  </div>
                  <Link href={`/orders/${pl.order_id}?tab=packing`}
                    className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                    去确认 →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 待签核出货 */}
        <div id="shipment" className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">待签核出货</h2>
          {!pendingShipment?.length ? (
            <p className="text-gray-400 text-sm text-center py-4">暂无待签核</p>
          ) : (
            <div className="space-y-3">
              {(pendingShipment as any[]).map((sc: any) => (
                <div key={sc.id} className="flex items-center justify-between p-4 rounded-xl bg-orange-50">
                  <div>
                    <span className="font-medium text-gray-900">{sc.orders?.order_no}</span>
                    <span className="ml-2 text-sm text-gray-500">{sc.orders?.customer_name}</span>
                    <span className="ml-3 text-xs text-gray-400">出货：{sc.shipment_qty} 件</span>
                    <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${sc.warehouse_sign_id ? 'bg-green-100 text-green-600' : 'bg-orange-100 text-orange-600'}`}>
                      仓库：{sc.warehouse_sign_id ? '已签' : '待签'}
                    </span>
                  </div>
                  <Link href={`/orders/${sc.order_id}?tab=shipment`}
                    className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                    去签核 →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 待确认发料单 */}
        <div id="issue" className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">待确认发料单</h2>
          {!pendingIssue?.length ? (
            <p className="text-gray-400 text-sm text-center py-4">暂无待处理</p>
          ) : (
            <div className="space-y-3">
              {(pendingIssue as any[]).map((slip: any) => (
                <div key={slip.id} className="flex items-center justify-between p-4 rounded-xl bg-purple-50">
                  <div>
                    <span className="font-medium text-gray-900">{slip.orders?.order_no}</span>
                    <span className="ml-2 text-sm text-gray-500">{slip.orders?.customer_name}</span>
                    {slip.issued_to && <span className="ml-3 text-xs text-gray-400">→ {slip.issued_to}</span>}
                  </div>
                  <Link href={`/orders/${slip.order_id}?tab=bom`}
                    className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
                    查看 →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
