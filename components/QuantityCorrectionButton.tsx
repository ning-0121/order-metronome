'use client';

/**
 * 受控「数量修正」入口(方案 C)——数量读错/套装漏算时就地改,不用取消重建。
 * 仅 admin / 业务执行经理 / 开发业务经理可见(与改单审批同口径)。
 * 提交走 correctOrderQuantity:等比缩放明细 + 重跑采购/财务/生产;开裁后需二次确认。
 */

import { useState } from 'react';
import { correctOrderQuantity } from '@/app/actions/order-quantity-correction';
import { useRouter } from 'next/navigation';

export function QuantityCorrectionButton({ orderId, currentQty }: { orderId: string; currentQty: number | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState('');
  const [mode, setMode] = useState<'keep' | 'scale'>('keep');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState('');

  async function submit(force = false) {
    const n = Math.round(Number(qty) || 0);
    if (!(n > 0)) { setMsg('请填新总件数'); return; }
    setBusy(true); setMsg(''); if (force) setWarn('');
    const r = await correctOrderQuantity({ orderId, newTotalQty: n, revenueMode: mode, reason: reason || undefined, force });
    setBusy(false);
    if ((r as any).needsConfirm) { setWarn((r as any).warning || '已开裁,确认强制修正?'); return; }
    if ((r as any).error) { setMsg((r as any).error); return; }
    setMsg((r as any).summary || '已修正');
    setWarn('');
    setTimeout(() => { setOpen(false); router.refresh(); }, 1200);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-indigo-600 hover:underline">
        ✏️ 修正数量（读错/套装漏算）
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3 max-w-lg">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-gray-800">✏️ 修正订单数量</h4>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
      </div>
      <p className="text-xs text-gray-500">
        当前总件数 <b className="text-gray-700">{currentQty ?? '—'}</b>。用于填错/套装漏算的<b>就地修正</b>(会等比缩放逐款明细并重跑采购/财务/生产)。<b>不是</b>客户真加量——真加量请走「订单修改申请·加单」。
      </p>
      <div className="flex items-center gap-2 text-sm">
        <label className="text-gray-600 whitespace-nowrap">新总件数</label>
        <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="如 3600" className="rounded border border-gray-300 px-2 py-1 w-32 text-right" />
        <span className="text-xs text-gray-400">(1800 套×2 件 = 3600)</span>
      </div>
      <div className="text-sm space-y-1">
        <div className="text-gray-600">应收口径:</div>
        <label className="flex items-start gap-2 text-xs">
          <input type="radio" checked={mode === 'keep'} onChange={() => setMode('keep')} className="mt-0.5" />
          <span><b>应收保持不变</b>(套装按套报价:件数翻倍但总价不变 → 单价自动变件价)</span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="radio" checked={mode === 'scale'} onChange={() => setMode('scale')} className="mt-0.5" />
          <span><b>应收随件数等比</b>(单价不变、总价按新件数重算)</span>
        </label>
      </div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="修正原因(可选,如:PO按套下单读成件)" className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
      {warn && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 space-y-1">
          <p>⚠️ {warn}</p>
          <button onClick={() => submit(true)} disabled={busy} className="px-2.5 py-1 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">仍要修正(强制)</button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => submit(false)} disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">{busy ? '修正中…' : '确认修正'}</button>
        {msg && <span className={`text-xs ${/失败|不对|请|错|不存在|无需|一致|0/.test(msg) ? 'text-rose-600' : 'text-emerald-600'}`}>{msg}</span>}
      </div>
    </div>
  );
}
