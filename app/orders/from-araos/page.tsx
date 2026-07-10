/**
 * /orders/from-araos —— araos 待建单：开发系统确认的 PO（全量数据 + PO 原件）落到这里，
 * 业务补运营字段后一键建单（复用 createOrder，正确打里程碑）。Server component + 角色门禁。
 */
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { listPendingAraosPOs, buildOrderFromAraosPO } from '@/app/actions/araos-po';

const CAN_CREATE_ORDER = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];

export const dynamic = 'force-dynamic';

export default async function FromAraosPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => CAN_CREATE_ORDER.includes(r))) redirect('/dashboard');

  const pos = await listPendingAraosPOs();
  const inputCls = 'w-full mt-1 px-2 py-1.5 text-sm border rounded-md bg-white';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold">araos 待建单</h1>
        <p className="text-sm text-gray-500 mt-1">开发系统确认的 PO（含 PO 原件）在此一键建单。客户/款色/数量已预填，补内部单号等运营字段即可。</p>
      </div>

      {sp.error && (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">建单失败：{sp.error}</div>
      )}

      {pos.length === 0 ? (
        <div className="rounded-lg border py-12 text-center text-sm text-gray-500">暂无待建单的 araos PO。开发系统确认订单后会出现在这里。</div>
      ) : (
        pos.map((po) => (
          <div key={po.id} className="rounded-lg border overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 border-b flex items-center justify-between gap-3 flex-wrap">
              <div className="font-semibold">{po.customerName || '（未命名客户）'}{po.poNumber && <span className="ml-2 text-xs text-gray-500">PO {po.poNumber}</span>}</div>
              <div className="flex items-center gap-3 text-xs">
                {po.poFileUrl
                  ? <a href={po.poFileUrl} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">📎 PO 原件</a>
                  : <span className="text-gray-400">无 PO 原件</span>}
                <span className="text-gray-400">{new Date(po.receivedAt).toLocaleString()}</span>
              </div>
            </div>

            <div className="p-4 space-y-3 text-sm">
              {/* araos 数据（只读预览） */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs text-gray-600">
                {po.contactName && <div><span className="text-gray-400">联系人</span> {po.contactName}</div>}
                {po.quantity != null && <div><span className="text-gray-400">数量</span> {po.quantity}</div>}
                {po.requiredDelivery && <div><span className="text-gray-400">要求交期</span> {po.requiredDelivery}</div>}
                {!po.customerId && <div className="text-red-600 col-span-2">⚠ 未匹配客户，需先在客户库确认</div>}
              </div>
              {po.brandRequirements && <div className="text-xs text-gray-600"><span className="text-gray-400">品牌要求：</span>{po.brandRequirements}</div>}
              {po.productLines.length > 0 && (
                <div className="rounded border divide-y text-xs">
                  {po.productLines.map((l, i) => (
                    <div key={i} className="flex gap-4 px-2 py-1">
                      <span className="font-medium flex-1">{l.style ?? '款式'}</span>
                      {l.qty != null && <span className="text-gray-500">×{l.qty}</span>}
                      {l.unit_price != null && <span className="text-gray-500">${l.unit_price}</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* 运营字段 + 一键建单 */}
              <form action={buildOrderFromAraosPO} className="grid md:grid-cols-3 gap-3 pt-1 border-t">
                <input type="hidden" name="inboxId" value={po.id} />
                <label className="block text-xs text-gray-600">内部订单号 *
                  <input name="internal_order_no" required placeholder="订单册编号" className={inputCls} />
                </label>
                <label className="block text-xs text-gray-600">贸易条款 *
                  <select name="incoterm" className={inputCls} defaultValue="FOB">
                    <option value="FOB">FOB</option><option value="DDP">DDP</option>
                    <option value="RMB_EX_TAX">RMB 未税</option><option value="RMB_INC_TAX">RMB 含税</option>
                  </select>
                </label>
                <label className="block text-xs text-gray-600">订单类型 *
                  <select name="order_type" className={inputCls} defaultValue="bulk">
                    <option value="bulk">大货</option><option value="sample">样品</option><option value="repeat">返单</option>
                  </select>
                </label>
                <label className="block text-xs text-gray-600">工厂交期
                  <input name="factory_date" type="date" className={inputCls} />
                </label>
                <label className="block text-xs text-gray-600">颜色数
                  <input name="color_count" type="number" defaultValue={po.productLines.length || 1} className={inputCls} />
                </label>
                <label className="block text-xs text-gray-600">总数量
                  <input name="total_quantity" type="number" defaultValue={po.quantity ?? undefined} className={inputCls} />
                </label>
                <div className="md:col-span-3">
                  <button type="submit" className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50" disabled={!po.customerId}>
                    一键建单 → 生成订单（打里程碑）
                  </button>
                </div>
              </form>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
