import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { CustomerEmailMappingPanel } from '@/components/CustomerEmailMappingPanel';

const TIER_STYLES: Record<string, string> = {
  A: 'bg-indigo-100 text-indigo-700',
  B: 'bg-blue-100 text-blue-700',
  C: 'bg-gray-100 text-gray-500',
};

const FOLLOWUP_STYLES: Record<string, string> = {
  normal: 'bg-green-100 text-green-700',
  due: 'bg-yellow-100 text-yellow-700',
  overdue: 'bg-orange-100 text-orange-700',
  at_risk: 'bg-red-100 text-red-700',
  inactive: 'bg-gray-100 text-gray-400',
};

const FOLLOWUP_LABELS: Record<string, string> = {
  normal: '正常',
  due: '待跟进',
  overdue: '逾期跟进',
  at_risk: '高风险',
  inactive: '不活跃',
};

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

  const customerNames = customers.map(c => c.name);

  // 批量查询（单次拉取，不 N+1）
  const [{ data: memories }, { data: rhythms }] = await Promise.all([
    (supabase.from('customer_memory') as any)
      .select('customer_id, content, risk_level, category, created_at')
      .order('created_at', { ascending: false })
      .limit(200),
    (supabase.from('customer_rhythm') as any)
      .select('customer_name, tier, risk_score, followup_status, next_followup_at, last_contact_at, total_order_value_usd, risk_factors')
      .in('customer_name', customerNames),
  ]);

  const memoryMap = new Map<string, any[]>();
  for (const m of memories || []) {
    const list = memoryMap.get(m.customer_id) || [];
    list.push(m);
    memoryMap.set(m.customer_id, list);
  }

  // customer_rhythm 是 customer profile 的唯一 SoT，页面只读不计算
  const rhythmMap = new Map<string, any>();
  for (const r of rhythms || []) rhythmMap.set(r.customer_name, r);

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
            const rhythm = rhythmMap.get(c.name) ?? null;

            return (
              <div key={c.name} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* 客户头部 */}
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-lg">
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-bold text-gray-900 text-lg">{c.name}</h2>
                        {rhythm?.tier && (
                          <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${TIER_STYLES[rhythm.tier] ?? 'bg-gray-100 text-gray-500'}`}>
                            {rhythm.tier}类客户
                          </span>
                        )}
                        {rhythm?.followup_status && rhythm.followup_status !== 'normal' && (
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${FOLLOWUP_STYLES[rhythm.followup_status] ?? ''}`}>
                            {FOLLOWUP_LABELS[rhythm.followup_status] ?? rhythm.followup_status}
                          </span>
                        )}
                      </div>
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

                {/* 邮箱域名绑定 */}
                <div className="px-5 pb-1">
                  <CustomerEmailMappingPanel customerName={c.name} />
                </div>

                {/* 客户画像（SoT: customer_rhythm，只读）*/}
                <div className="px-5 pb-2">
                  <details>
                    <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                      📊 客户画像
                    </summary>
                    {rhythm ? (
                      <div className="mt-2 rounded-lg bg-gray-50 p-3 grid grid-cols-4 gap-3 text-center">
                        <div>
                          <div className="text-xs text-gray-400">风险评分</div>
                          <div className={`text-sm font-semibold ${
                            (rhythm.risk_score ?? 0) >= 70 ? 'text-red-600' :
                            (rhythm.risk_score ?? 0) >= 40 ? 'text-yellow-600' : 'text-green-600'
                          }`}>
                            {rhythm.risk_score != null ? rhythm.risk_score : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-400">客户等级</div>
                          <div className="text-sm font-semibold text-gray-700">{rhythm.tier ?? '—'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-400">下次跟进</div>
                          <div className="text-sm font-semibold text-gray-700">
                            {rhythm.next_followup_at ? formatDate(rhythm.next_followup_at) : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-400">上次联系</div>
                          <div className="text-sm font-semibold text-gray-700">
                            {rhythm.last_contact_at ? formatDate(rhythm.last_contact_at) : '—'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-gray-400 px-1">暂无画像数据</p>
                    )}
                  </details>
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
