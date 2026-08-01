'use client';

/**
 * 国内送仓信息就地补录(2026-07-31)。
 *
 * 建单时仓库常常还没定,所以 CEO 2026-07-28 撤掉了「包装方式确认」前的硬卡。
 * 但撤掉硬卡之后没人发现:**建单之后全库再没有第二处能写这 5 列**,createOrder 是唯一写入点。
 * 详情页那条黄条还指引"请在「订单基本信息」编辑区域补充"—— 那个区域并不存在。
 * 结果 48 张单卡在「国内送仓完成」pending:完成它要送仓信息,却无处可填。
 *
 * 这个组件就长在那条黄条里 —— 提示缺什么的地方,直接就能补,不用再跳去别处找。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateOrderDeliveryInfo } from '@/app/actions/orders';

interface Props {
  orderId: string;
  warehouseName: string | null;
  address: string | null;
  contact: string | null;
  phone: string | null;
  requiredAt: string | null;
  canEdit: boolean;
}

const d10 = (v: string | null) => (v ? String(v).slice(0, 10) : '');

export function DeliveryInfoEdit(p: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [w, setW] = useState(p.warehouseName || '');
  const [a, setA] = useState(p.address || '');
  const [c, setC] = useState(p.contact || '');
  const [ph, setPh] = useState(p.phone || '');
  const [r, setR] = useState(d10(p.requiredAt));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!p.canEdit) {
    return <p className="text-xs text-amber-700 mt-1.5">请联系业务或物流补录送仓信息。</p>;
  }

  async function save() {
    setBusy(true); setErr(null);
    const res = await updateOrderDeliveryInfo(p.orderId, {
      warehouseName: w, address: a, contact: c, phone: ph, requiredAt: r,
    });
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setErr(null); }}
        className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700">
        就地补录送仓信息
      </button>
    );
  }

  const inp = 'w-full text-sm border border-amber-300 rounded-lg px-2 py-1.5 bg-white';
  return (
    <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
      <label className="text-xs text-amber-900">
        <span className="block mb-1">仓库名称</span>
        <input value={w} onChange={(e) => setW(e.target.value)} placeholder="如:年年旺嘉兴仓" className={inp} />
      </label>
      <label className="text-xs text-amber-900">
        <span className="block mb-1">客户要求送达日期</span>
        <input type="date" value={r} onChange={(e) => setR(e.target.value)} className={inp} />
      </label>
      <label className="text-xs text-amber-900 sm:col-span-2">
        <span className="block mb-1">详细地址</span>
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="省市区 + 街道门牌" className={inp} />
      </label>
      <label className="text-xs text-amber-900">
        <span className="block mb-1">收货联系人</span>
        <input value={c} onChange={(e) => setC(e.target.value)} className={inp} />
      </label>
      <label className="text-xs text-amber-900">
        <span className="block mb-1">联系电话</span>
        <input value={ph} onChange={(e) => setPh(e.target.value)} className={inp} />
      </label>
      {err && <p className="sm:col-span-2 text-xs text-rose-700">{err}</p>}
      <div className="sm:col-span-2 flex gap-2">
        <button onClick={save} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
        <button onClick={() => setOpen(false)} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 text-amber-800 disabled:opacity-50">
          取消
        </button>
        <span className="text-[11px] text-amber-700/80 self-center">
          能填多少填多少,没定的可以留空,之后再来补。
        </span>
      </div>
    </div>
  );
}
