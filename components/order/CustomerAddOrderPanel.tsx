'use client';

import { useState } from 'react';
import { LineItemMatrixEditor } from '@/components/order/LineItemMatrixEditor';
import { submitCustomerAddOrder } from '@/app/actions/order-amendments';

/**
 * 客户加单(2026-07-11):复用富录入表录增量明细(款/色/码×量,可加新款新色),
 * 提交走改单审批闸;批准后追加进 order_line_items 并同步采购/财务/生产。
 */
export function CustomerAddOrderPanel({ orderId, canSeeFin = false }: { orderId: string; canSeeFin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [styles, setStyles] = useState<any[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 展平 styles → 增量行(每色一行,仅留有正数量的行)
  function toRows() {
    const rows: any[] = [];
    for (const st of styles) {
      for (const c of (st.colors || [])) {
        const sizes: Record<string, number> = {};
        for (const [k, v] of Object.entries(c.sizes || {})) { const n = Number(v) || 0; if (n > 0) sizes[k] = n; }
        if (Object.keys(sizes).length === 0) continue;
        rows.push({
          style_no: st.style_no || '', product_name: st.product_name || '',
          color_cn: c.color_cn || '', color_en: c.color_en || '', sizes,
          po_unit_price: canSeeFin && st.po_unit_price !== '' && st.po_unit_price != null ? Number(st.po_unit_price) : null,
        });
      }
    }
    return rows;
  }

  async function submit() {
    const rows = toRows();
    if (rows.length === 0) { setMsg('❌ 请录入至少一行加单明细(款/色 + 尺码数量>0)'); return; }
    if (reason.trim().length < 5) { setMsg('❌ 请填写加单原因(至少5字)'); return; }
    setBusy(true); setMsg('');
    const r = await submitCustomerAddOrder(orderId, rows, reason.trim());
    setBusy(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg('✅ 客户加单已提交,待管理员审批;批准后自动追加明细并同步采购/财务/生产');
    setStyles([]); setReason('');
    setTimeout(() => { setOpen(false); setMsg(''); }, 2500);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="text-sm px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-medium">
        ➕ 客户加单
      </button>
    );
  }

  const addQty = toRows().reduce((s, r) => s + Object.values(r.sizes).reduce((a: number, v: any) => a + (Number(v) || 0), 0), 0);

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-emerald-800">➕ 客户加单</div>
        <button onClick={() => { setOpen(false); setMsg(''); }} className="text-xs text-gray-400 hover:text-gray-600">收起</button>
      </div>
      <p className="text-[11px] text-gray-500">
        录增量明细(款/色/码×数量,可加新款新色{canSeeFin ? '、选填加单价' : ''})。提交后走管理员审批;
        批准即追加进逐款明细,并同步采购(已下单走补采购)/财务(应收)/生产。加单以独立新行保留批次痕迹。
      </p>
      <LineItemMatrixEditor value={styles} onChange={setStyles} canEdit showPrice={canSeeFin} />
      <label className="block">
        <span className="text-xs text-gray-500">加单原因(至少5字)</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
          placeholder="如「客户追加黑色 M 200 / L 100 件」"
          className="w-full mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
      </label>
      {msg && <div className={`text-xs ${msg.startsWith('✅') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</div>}
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={busy}
          className="text-sm px-4 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">
          {busy ? '提交中…' : `提交加单审批${addQty > 0 ? `（+${addQty}件）` : ''}`}
        </button>
        <span className="text-[11px] text-gray-400">提交后在下方「订单修改申请」列表可见,由管理员审批。</span>
      </div>
    </div>
  );
}
