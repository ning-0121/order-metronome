'use client';

/**
 * ETD / ETA 补录(2026-07-30)。
 *
 * 建单时 ETD/ETA 改成了选填(船期常常还没定),但订单详情页这两个字段一直是纯展示、
 * 唯一能写它们的 updateOrder 又是全库零调用的孤儿 action —— 等于留空后补不回来。
 * 这里补上那条通道:就地改、只写这两列、走日期链校验。
 *
 * 排期不自动重算:补了 ETA 会把 DDP 的排期锚点从「出厂日兜底」换回 ETA,所有节点日期都会挪。
 * 那是有感知的动作,提示用户去「重算排期」显式做,不在这里偷偷改一堆日期。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateOrderShippingDates } from '@/app/actions/orders';

interface Props {
  orderId: string;
  etd: string | null;
  warehouseDueDate: string | null;
  canEdit: boolean;
}

const d10 = (v: string | null) => (v ? String(v).slice(0, 10) : '');

export function ShippingDatesEdit({ orderId, etd, warehouseDueDate, canEdit }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [e, setE] = useState(d10(etd));
  const [w, setW] = useState(d10(warehouseDueDate));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const missing = !etd || !warehouseDueDate;

  if (!canEdit) {
    return (
      <span className="text-sm font-medium text-gray-900">
        {d10(etd) || '—'} / {d10(warehouseDueDate) || '—'}
      </span>
    );
  }

  async function save() {
    setBusy(true); setMsg(null);
    const res = await updateOrderShippingDates(orderId, { etd: e, warehouseDueDate: w });
    setBusy(false);
    if (res.error) { setMsg(res.error); return; }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setMsg(null); }}
        className="text-sm font-medium text-indigo-600 hover:underline text-right"
        title="点击补录/修改船期">
        {d10(etd) || '—'} / {d10(warehouseDueDate) || '—'}
        {missing && <span className="ml-1 text-[10px] text-amber-600">补录</span>}
      </button>
    );
  }

  return (
    <div className="text-right">
      <div className="flex items-center gap-1 justify-end flex-wrap">
        <input type="date" value={e} onChange={(ev) => setE(ev.target.value)}
          title="ETD 离港日" className="text-xs border rounded px-1.5 py-1" />
        <span className="text-xs text-gray-400">→</span>
        <input type="date" value={w} onChange={(ev) => setW(ev.target.value)}
          title="ETA 到港/到仓日" className="text-xs border rounded px-1.5 py-1" />
        <button onClick={save} disabled={busy}
          className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
        <button onClick={() => { setOpen(false); setE(d10(etd)); setW(d10(warehouseDueDate)); setMsg(null); }}
          disabled={busy} className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 disabled:opacity-50">
          取消
        </button>
      </div>
      {msg && <p className="text-[11px] text-rose-600 mt-1">{msg}</p>}
      <p className="text-[10px] text-gray-400 mt-1">
        补录船期不会自动改排期。如需按 ETA 重排节点,请用「重算排期」。
      </p>
    </div>
  );
}
