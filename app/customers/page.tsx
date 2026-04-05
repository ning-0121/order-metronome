import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';

export default async function CustomersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 权限：仅业务/跟单/管理员/行政可访问
  const { data: profile } = await supabase.from('profiles').select('roles, role').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!userRoles.some(r => ['admin', 'sales', 'merchandiser', 'admin_assistant', 'production_manager'].includes(r))) {
    redirect('/dashboard');
  }

  // 获取所有订单按客户分组
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, customer_id, quantity, factory_name, incoterm, order_type, lifecycle_status, created_at, factory_date, etd')
    .order('created_at', { ascending: false });

  // 按客户分组统计
  const customerMap = new Map<string, {
    name: string;
    orders: any[];
    totalQty: number;
    activeCount: number;
    completedCount: number;
    latestOrder: string;
  }>();

  for (const o of orders || []) {
    if (!o.customer_name) continue;
    const existing = customerMap.get(o.customer_name) || {
      name: o.customer_name,
      orders: [],
      totalQty: 0,
      activeCount: 0,
      completedCount: 0,
      latestOrder: o.created_at,
    };
    existing.orders.push(o);
    existing.totalQty += o.quantity || 0;
    const ls = o.lifecycle_status || '';
    if (ls === '已完成' || ls === 'completed' || ls === '已复盘') existing.completedCount++;
    else existing.activeCount++;
    customerMap.set(o.customer_name, existing);
  }

  const customers = Array.from(customerMap.values())
    .sort((a, b) => b.orders.length - a.orders.length);

  // 获取客户记忆
  const { data: memories } = await (supabase.from('customer_memory') as any)
    .select('customer_id, content, risk_level, category, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  const memoryMap = new Map<string, any[]>();
  for (const m of memories || []) {
    const list = memoryMap.get(m.customer_id) || [];
    list.push(m);
    memoryMap.set(m.customer_id, list);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">客户管理</h1>
          <p className="mt-1 text-sm text-gray-500">共 {customers.length} 个客户</p>
        </div>
      </div>

      {customers.length === 0 ? (
        <div className="text-center py-12 text-gray-400">暂无客户数据</div>
      ) : (
        <div className="space-y-4">
          {customers.map(c => {
            const mems = memoryMap.get(c.name) || [];
            const highRiskMems = mems.filter(m => m.risk_level === 'high');
            const factories = [...new Set(c.orders.map((o: any) => o.factory_name).filter(Boolean))];

            return (
              <div key={c.name} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* 客户头部 */}
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <h2 className="font-bold text-gray-900 text-lg">{c.name}</h2>
                      <div className="flex items-center gap-3 text-sm text-gray-500 mt-0.5">
                        <span>{c.orders.length} 单</span>
                        <span>{c.totalQty.toLocaleString()} 件</span>
                        {factories.length > 0 && <span>工厂：{factories.slice(0, 3).join('、')}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {highRiskMems.length > 0 && (
                      <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-700 font-medium">
                        {highRiskMems.length} 个风险记录
                      </span>
                    )}
                    <div className="flex gap-2 text-center">
                      <div className="px-3 py-1 bg-blue-50 rounded-lg">
                        <div className="text-lg font-bold text-blue-700">{c.activeCount}</div>
                        <div className="text-xs text-gray-500">进行中</div>
                      </div>
                      <div className="px-3 py-1 bg-green-50 rounded-lg">
                        <div className="text-lg font-bold text-green-700">{c.completedCount}</div>
                        <div className="text-xs text-gray-500">已完成</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 客户记忆 */}
                {mems.length > 0 && (
                  <div className="px-5 pb-2">
                    <details>
                      <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700">
                        📋 客户记忆（{mems.length} 条）
                      </summary>
                      <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                        {mems.slice(0, 5).map((m: any, i: number) => (
                          <div key={i} className={`text-xs px-2 py-1 rounded ${
                            m.risk_level === 'high' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'
                          }`}>
                            {m.content}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}

                {/* 订单列表 */}
                <div className="border-t border-gray-100">
                  <div className="px-5 py-2 bg-gray-50">
                    <div className="grid grid-cols-6 gap-4 text-xs font-medium text-gray-500">
                      <span>订单号</span>
                      <span>数量</span>
                      <span>工厂</span>
                      <span>条款</span>
                      <span>关键日期</span>
                      <span>状态</span>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {c.orders.slice(0, 5).map((o: any) => {
                      const ls = o.lifecycle_status || '';
                      const isDone = ls === '已完成' || ls === 'completed' || ls === '已复盘';
                      return (
                        <Link key={o.id} href={`/orders/${o.id}`}
                          className="grid grid-cols-6 gap-4 px-5 py-2.5 text-sm hover:bg-gray-50 items-center">
                          <span className="font-medium text-indigo-600">{o.order_no}</span>
                          <span className="text-gray-700">{o.quantity ? `${o.quantity}件` : '-'}</span>
                          <span className="text-gray-600 truncate">{o.factory_name || '-'}</span>
                          <span className="text-gray-500">{o.incoterm}</span>
                          <span className="text-gray-500">{formatDate(o.factory_date || o.etd)}</span>
                          <span className={`text-xs font-medium ${isDone ? 'text-green-600' : 'text-blue-600'}`}>
                            {isDone ? '已完成' : '进行中'}
                          </span>
                        </Link>
                      );
                    })}
                    {c.orders.length > 5 && (
                      <div className="px-5 py-2 text-xs text-gray-400 text-center">
                        还有 {c.orders.length - 5} 个订单...
                        <Link href={`/orders?customer=${encodeURIComponent(c.name)}`} className="text-indigo-600 ml-1 hover:underline">
                          查看全部
                        </Link>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
