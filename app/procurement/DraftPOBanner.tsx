'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deletePurchaseOrder } from '@/app/actions/purchase-orders';
import { useDialogs } from '@/components/ui/useDialogs';
import type { PendingApprovalPO } from '@/app/actions/procurement';

const REASON_CN: Record<string, string> = {
  large_amount: '大额(≥5万)', price_variance: '价格偏差>5%', new_supplier: '新供应商',
  over_budget: '超预算', over_budget_total: '整单超预算', over_budget_material: '单料超预算(疑重复下单)',
  non_standard_terms: '非标账期',
};
const STATUS_CN: Record<string, string> = {
  draft: '草稿', placed: '已下单', confirmed: '已确认', receiving: '收货中', received: '已收货', closed: '已关闭',
};

/**
 * 草稿采购单箱(采购)——列已建未下单的草稿单;
 *  · 🗑 删除:清理建错/重复草稿(采购行退回待归单池,不丢核料需求);审批中的不可删。
 *  · ⚠ 疑重复:同订单+同物料已被别的活动采购单覆盖 → 标警指明「也在 PO-X」,交采购判断删哪张,防重复下单。
 */
export function DraftPOBanner({ pos, canDelete }: { pos: PendingApprovalPO[]; canDelete: boolean }) {
  const router = useRouter();
  const { confirm, dialog } = useDialogs();
  const [busy, setBusy] = useState('');

  if (pos.length === 0) return null;

  async function handleDelete(p: PendingApprovalPO) {
    const dupHint = (p.dupWith && p.dupWith.length)
      ? `\n\n⚠ 此单疑与 ${p.dupWith.map((d) => d.po_no).filter(Boolean).join('、')} 重复。`
      : '';
    if (!(await confirm({
      title: `删除草稿采购单 ${p.po_no || ''}?`,
      message: `采购行会退回「待归单」池(核料需求不丢,可重新归单),仅删除这张草稿单。${dupHint}`,
      confirmText: '删除', cancelText: '取消',
    }))) return;
    setBusy(p.id);
    const res = await deletePurchaseOrder(p.id);
    setBusy('');
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    await confirm({ title: `✅ 已删除 ${p.po_no || ''}`, message: `${(res as any).releasedLines ?? 0} 条采购行已退回待归单池。`, confirmText: '知道了' });
    router.refresh();
  }

  return (
    <div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-sm font-bold text-orange-800">🧾 草稿采购单({pos.length})待下单/待审批</span>
        <span className="text-xs text-orange-600">这些单已建但还没真正下单;待审批的需先审批,可下单的进 PO 页传凭证后下单。建错/重复的可直接删除(退回待归单池)。</span>
      </div>
      <div className="space-y-2">
        {pos.map((p) => {
          const isPending = p.approval_status === 'pending';
          const tbd = !isPending && p.price_tbd === true;
          const noPrice = !isPending && !tbd && (p.total_amount == null || Number(p.total_amount) <= 0);
          const dup = p.dupWith && p.dupWith.length > 0;
          return (
            <div key={p.id} className={`rounded-lg border px-3 py-2 bg-white ${dup ? 'border-rose-300' : 'border-orange-200'}`}>
              <div className="flex items-center gap-3 flex-wrap">
                <Link href={`/procurement/po/${p.id}`} className="text-sm font-semibold text-indigo-600 hover:underline">{p.po_no}</Link>
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${isPending ? 'bg-amber-100 text-amber-700' : noPrice ? 'bg-rose-100 text-rose-700' : tbd ? 'bg-purple-100 text-purple-700' : 'bg-sky-100 text-sky-700'}`}>
                  {isPending ? '待审批' : noPrice ? '待填价' : tbd ? '价格待定·可下单' : '可下单(未下单)'}
                </span>
                {dup && <span className="text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-medium">⚠ 疑重复下单</span>}
                <span className="text-xs text-gray-500">{p.supplier_name || '—'}</span>
                {p.total_amount != null && <span className="text-xs text-gray-700">¥{p.total_amount}</span>}
                <span className="text-xs text-gray-400">
                  {(p.orders || []).map((o) => o.internal_order_no || o.order_no).filter(Boolean).join(' / ')}
                </span>
                {isPending && (
                  <>
                    <div className="flex items-center gap-1 flex-wrap">
                      {(p.reasons || []).map((r) => (
                        <span key={r} className="text-[11px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">{REASON_CN[r] || r}</span>
                      ))}
                    </div>
                    <span className="text-[11px] text-gray-500">
                      需{(p.required_by || []).map((s) => s === 'finance' ? '财务' : '采购经理').join('+')}审批
                    </span>
                  </>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {canDelete && (
                    <button onClick={() => handleDelete(p)} disabled={busy !== '' || isPending}
                      title={isPending ? '审批中,不能删除(先等审批结果/驳回)' : '删除此草稿单(采购行退回待归单池)'}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-rose-200 text-rose-600 font-medium hover:bg-rose-50 disabled:opacity-40">
                      {busy === p.id ? '删除中…' : '🗑 删除'}
                    </button>
                  )}
                  <Link href={`/procurement/po/${p.id}`} className="text-xs px-3 py-1.5 rounded-lg bg-orange-600 text-white font-medium hover:bg-orange-700">
                    {isPending ? '去审批 →' : noPrice ? '去填价 →' : '去下单 →'}
                  </Link>
                </div>
              </div>
              {dup && (
                <div className="mt-1.5 text-[11px] text-rose-600 pl-1">
                  同订单同物料已被其他采购单覆盖 ——
                  {p.dupWith!.map((d, i) => (
                    <span key={i} className="ml-1">
                      {d.po_no || '(未编号)'}{d.status ? `(${STATUS_CN[d.status] || d.status})` : ''}:{d.materials.join('、')}{i < p.dupWith!.length - 1 ? ' ;' : ''}
                    </span>
                  ))}
                  。请确认是否重复,重复的删掉一张。
                </div>
              )}
            </div>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}
