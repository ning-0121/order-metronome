import Link from 'next/link';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { orderStatPieces } from '@/lib/services/analytics-metrics';

export const dynamic = 'force-dynamic';

/**
 * 逐款明细体检页(2026-07-27 CEO;2026-07-30 扩)。
 *
 * 统计件数 = Σ(qty_pcs × set_multiplier)(明细里 qty_pcs 存的是**套数**,靠倍率换回件),
 * 无明细则回退 orders.quantity。
 *
 * 口径事实(2026-07-30 实测 46 张有明细的单,38 张精确相等):
 *   **orders.quantity 存的已经是【件】**,套装单也是;quantity_unit='套' 只是套装标记,
 *   不代表那个数字是套数。所以「无明细 → 回退 quantity」本身是对的,不是低估。
 *   反过来,明细 Σ(qty_pcs×mul) 若 ≠ quantity,就说明**明细不全**(漏录款色 / 套装行漏设 ×2),
 *   而统计恰恰优先用明细 → 这才是真正被少算的那批。
 *
 * 所以本页查两类:
 *   A 缺明细    —— 一行明细都没有(回退 quantity,统计不出错,但生产/采购/PI 用不上明细)
 *   B 明细对不上 —— 有明细但 Σ ≠ quantity,**统计被少算**,最该修(原页面看不见这类)
 *
 * 只读;管理/督导看全部,业务/跟单看自己负责的单。
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

  // 逐款明细:要 qty_pcs / set_multiplier 才能判「对不上」,不能只取 order_id
  const linesByOrder = new Map<string, Array<{ qty_pcs: number | null; set_multiplier: number | null }>>();
  const ids = list.map((o) => o.id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data: li } = await (svc.from('order_line_items') as any)
      .select('order_id, qty_pcs, set_multiplier').in('order_id', ids.slice(i, i + 300));
    for (const r of ((li || []) as any[])) {
      const a = linesByOrder.get(r.order_id) || [];
      a.push({ qty_pcs: r.qty_pcs, set_multiplier: r.set_multiplier });
      linesByOrder.set(r.order_id, a);
    }
  }

  const isSet = (o: any) => /套/.test(String(o.quantity_unit || ''));

  // A 缺明细
  const missing = list.filter((o) => !(linesByOrder.get(o.id) || []).length);
  missing.sort((a, b) => (isSet(b) ? 1 : 0) - (isSet(a) ? 1 : 0) || String(b.created_at).localeCompare(String(a.created_at)));
  const setMissing = missing.filter(isSet).length;

  // B 明细对不上(统计被少算)——用与分析页同一个 orderStatPieces,口径不另起一套
  const mismatch = list
    .filter((o) => (linesByOrder.get(o.id) || []).length)
    .map((o) => {
      const lines = linesByOrder.get(o.id)!;
      const pieces = orderStatPieces(o, lines);
      const qty = Number(o.quantity) || 0;
      const rawSum = lines.reduce((s, l) => s + (Number(l.qty_pcs) || 0) * (Number(l.set_multiplier) || 1), 0);
      return { o, lines, pieces, qty, gap: qty - pieces, zeroed: rawSum === 0 };
    })
    // 只报「少算」:明细多于 quantity 多半是 quantity 填漏,另案处理,不在本页误导补录。
    // zeroed(建了明细行但 qty_pcs 全空)即使 gap=0 也要报 —— 统计已被 orderStatPieces 回退 quantity 兜住,
    // 但明细本身是坏的(生产/采购/PI 拿不到数),不报就会两个区块都漏掉、彻底隐身。
    .filter((r) => r.zeroed || (r.qty > 0 && r.gap > 0))
    .sort((a, b) => b.gap - a.gap);
  const gapTotal = mismatch.reduce((s, r) => s + r.gap, 0);
  const zeroedCount = mismatch.filter((r) => r.zeroed).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2 mb-1">
        🧩 逐款明细体检{!canSeeAll && <span className="text-xs font-normal text-gray-400">(仅你负责的订单)</span>}
      </h1>
      <p className="text-sm text-gray-500 mb-5">
        统计件数 = Σ(<b>qty_pcs × set_multiplier</b>)——明细里 <b>qty_pcs 填套数</b>,倍率负责换成件;无明细才回退 <b>orders.quantity</b>。
        <br />
        <span className="text-gray-600">
          注意:<b>orders.quantity 存的已经是【件】</b>,套装单也是(实测 38/46 张有明细的单 Σ 与它精确相等)。
          所以缺明细<b>不会</b>让统计少算 —— 真正少算的是下面「明细对不上」那批。
        </span>
      </p>

      {/* ── B 明细对不上:统计真被少算,排最前 ── */}
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h2 className="text-base font-semibold text-gray-900">⚠️ 明细与数量对不上</h2>
        <span className="text-sm text-gray-500">
          共 <b className="text-red-600">{mismatch.length}</b> 单,合计少算 <b className="text-red-600">{gapTotal.toLocaleString()}</b> 件
          {zeroedCount > 0 && <>,另 <b className="text-amber-700">{zeroedCount}</b> 单明细全是 0</>}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        明细 Σ 小于订单数量 → 多半是<b>款/色没录全</b>,或<b>套装行漏把倍率设成 2</b>(明细只记了套数)。
        统计优先用明细,所以这批直接被少算。
        <br />
        <span className="text-amber-700">
          「明细全是 0」= 只建了行没填数量:统计已回退 orders.quantity <b>不会少算</b>,但明细本身是坏的,
          生产任务单 / 采购归料 / PI 都拿不到数,仍需补。
        </span>
      </p>
      <div className="rounded-xl border border-red-200 overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead className="bg-red-50 text-gray-600 text-xs">
            <tr>
              <th className="text-left px-3 py-2.5">订单 / 客户</th>
              <th className="text-left px-3 py-2.5">病因</th>
              <th className="text-right px-3 py-2.5">订单数量(件)</th>
              <th className="text-right px-3 py-2.5">明细算出</th>
              <th className="text-right px-3 py-2.5">少算</th>
              <th className="text-left px-3 py-2.5">状态</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {mismatch.map(({ o, pieces, qty, gap, zeroed }) => (
              <tr key={o.id} className="border-t border-red-100">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-gray-900">{o.internal_order_no || o.order_no || '—'}</div>
                  <div className="text-xs text-gray-500">{o.customer_name || '—'}</div>
                </td>
                <td className="px-3 py-2.5">
                  {zeroed
                    ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">明细全是 0</span>
                    : isSet(o) && pieces * 2 === qty
                      ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">套装漏设 ×2</span>
                      : <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">款/色没录全</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{qty.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{zeroed ? '0(已兜底)' : pieces.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right tabular-nums font-semibold">
                  {zeroed
                    ? <span className="text-gray-400" title="统计已回退 orders.quantity,不少算;但明细是坏的">—</span>
                    : <span className="text-red-600">{gap.toLocaleString()}</span>}
                </td>
                <td className="px-3 py-2.5 text-gray-600">{o.lifecycle_status}</td>
                <td className="px-3 py-2.5 text-right">
                  <Link href={`/orders/${o.id}?tab=manufacturing_order`} className="text-xs text-indigo-600 hover:underline whitespace-nowrap">去修正 ›</Link>
                </td>
              </tr>
            ))}
            {mismatch.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">✅ 没有明细与数量对不上的订单。</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ── A 缺明细:统计不受影响,但生产/采购/PI 用得上 ── */}
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h2 className="text-base font-semibold text-gray-900">🧾 完全没有逐款明细</h2>
        <span className="text-sm text-gray-500">共 <b className="text-amber-600">{missing.length}</b> 单,其中套装 <b>{setMissing}</b> 单</span>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        统计会回退 orders.quantity(件),<b>数字不会错</b>;但生产任务单 / 采购归料 / PI 都依赖明细,能补则补。
        补录时 <b className="text-red-600">qty_pcs 填套数、倍率填 2</b> —— 直接把件数填进 qty_pcs 会让统计翻倍。
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
              <tr key={o.id} className={`border-t border-gray-100 ${isSet(o) ? 'bg-amber-50/40' : ''}`}>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-gray-900">{o.internal_order_no || o.order_no || '—'}</div>
                  <div className="text-xs text-gray-500">{o.customer_name || '—'}</div>
                </td>
                <td className="px-3 py-2.5">
                  {isSet(o)
                    ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">套装·缺明细</span>
                    : <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">缺明细</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{o.quantity != null ? `${Number(o.quantity).toLocaleString()} 件` : '—'}</td>
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
