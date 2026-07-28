import Link from 'next/link';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';

export const dynamic = 'force-dynamic';

/**
 * 缺逐款明细检查页(2026-07-27 CEO):列出"应有明细却没录/漏录"的在办订单,方便补录 —— 统计件数
 * (套→件按 qty_pcs×set_multiplier)依赖明细全不全;缺明细的只能回退 orders.quantity(对套装不可靠)。
 * 红=套装单缺明细(最该补,统计会错)、黄=普通单缺明细。只读、管理/督导可见。
 */
export default async function MissingLineItemsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <div className="max-w-5xl mx-auto p-8 text-center text-gray-400">请先登录</div>;
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  // 2026-07-27 CEO:补明细是业务/跟单的活 → 放开给他们,但只看/补【自己负责的订单】;管理层看全部。
  const canSeeAll = hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS');
  const canSeeOwn = roles.some((r) => ['sales', 'merchandiser'].includes(r));
  if (!canSeeAll && !canSeeOwn) {
    return <div className="max-w-5xl mx-auto p-8"><div className="rounded-xl bg-red-50 border border-red-200 p-6 text-center text-red-600">仅管理/督导 或 业务/跟单 可查看</div></div>;
  }

  const svc = createServiceRoleClient();
  // 在办 + 已完成的真实订单(排除 取消/归档/样品);缺明细影响统计的就是这些
  let q = (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, quantity, quantity_unit, order_purpose, lifecycle_status, created_at, owner_user_id, created_by')
    .not('lifecycle_status', 'in', '("cancelled","已取消","archived","已归档")')
    .order('created_at', { ascending: false }).limit(2000);
  // 非管理层(业务/跟单)只看自己负责或建的单
  if (!canSeeAll) q = q.or(`owner_user_id.eq.${user.id},created_by.eq.${user.id}`);
  const { data: orders } = await q;
  const list = ((orders || []) as any[]).filter((o) => (o.order_purpose || 'production') !== 'sample');

  // 有明细的订单集合
  const withLines = new Set<string>();
  const ids = list.map((o) => o.id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data: li } = await (svc.from('order_line_items') as any).select('order_id').in('order_id', ids.slice(i, i + 300));
    for (const r of ((li || []) as any[])) withLines.add(r.order_id);
  }

  const missing = list.filter((o) => !withLines.has(o.id));
  const isSet = (o: any) => String(o.quantity_unit || '') === '套';
  // 套装缺明细(统计必错)排最前
  missing.sort((a, b) => (isSet(b) ? 1 : 0) - (isSet(a) ? 1 : 0) || String(b.created_at).localeCompare(String(a.created_at)));
  const setMissing = missing.filter(isSet).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">🧩 缺逐款明细检查{!canSeeAll && <span className="text-xs font-normal text-gray-400">(仅你负责的订单)</span>}</h1>
        <span className="text-sm text-gray-500">共 <b className="text-amber-600">{missing.length}</b> 单缺明细,其中 <b className="text-red-600">{setMissing}</b> 单是套装(统计会错)</span>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        统计件数按逐款明细 <b>qty_pcs × set_multiplier</b> 算(套→件)。缺明细的单只能回退 <b>orders.quantity</b>——对套装不可靠。
        <span className="text-red-600">红=套装单缺明细(最该补)</span>、黄=普通单缺明细。点进订单在「生产任务单 / 逐款明细」补录。
      </p>

      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2.5">订单 / 客户</th>
              <th className="text-left px-3 py-2.5">类型</th>
              <th className="text-right px-3 py-2.5">数量</th>
              <th className="text-left px-3 py-2.5">状态</th>
              <th className="text-left px-3 py-2.5">建单</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {missing.map((o) => (
              <tr key={o.id} className={`border-t border-gray-100 ${isSet(o) ? 'bg-red-50/40' : ''}`}>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-gray-900">{o.internal_order_no || o.order_no || '—'}</div>
                  <div className="text-xs text-gray-500">{o.customer_name || '—'}</div>
                </td>
                <td className="px-3 py-2.5">
                  {isSet(o)
                    ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">套装·缺明细</span>
                    : <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">缺明细</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{o.quantity != null ? `${o.quantity.toLocaleString()} ${o.quantity_unit || '件'}` : '—'}</td>
                <td className="px-3 py-2.5 text-gray-600">{o.lifecycle_status}</td>
                <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{String(o.created_at || '').slice(0, 10)}</td>
                <td className="px-3 py-2.5 text-right">
                  <Link href={`/orders/${o.id}?tab=manufacturing_order`} className="text-xs text-indigo-600 hover:underline whitespace-nowrap">去补录 ›</Link>
                </td>
              </tr>
            ))}
            {missing.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-gray-400">✅ 所有在办订单都已录逐款明细。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
