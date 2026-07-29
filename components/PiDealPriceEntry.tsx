'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getOrderDealPrices, saveOrderDealPrices } from '@/app/actions/order-line-items';

/**
 * PI 成交价快录(2026-07-27 CEO):挂在 PI 客户确认节点表单顶部,就地录逐款客户成交价,
 * 免绕到「生产任务单」tab。仅财务/业务/admin(canSeeFin)渲染;经销单建单已录价时自动预填。
 * 保存后 router.refresh → PI 完成硬闸(读 po_unit_price)自动放行。
 */
export function PiDealPriceEntry({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [styles, setStyles] = useState<Array<{ style_no: string; product_name: string; po_unit_price: string }> | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [orderPrice, setOrderPrice] = useState('');       // 无逐款明细时的整单成交价兜底
  const [qtyUnit, setQtyUnit] = useState('件');

  useEffect(() => {
    let alive = true;
    getOrderDealPrices(orderId).then((r: any) => {
      if (!alive) return;
      setCanEdit(!!r.canEdit); setStyles(r.styles || []);
      setOrderPrice(r.orderUnitPrice || ''); setQtyUnit(r.quantityUnit || '件');
    });
    return () => { alive = false; };
  }, [orderId]);

  if (!canEdit || styles === null) return null;

  // 兜底:订单没录逐款明细 → 录整单成交价(写 orders.unit_price,总额按套装口径自动算,门禁同样放行)
  if (styles.length === 0) {
    return (
      <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-4 mb-4">
        <div className="text-sm font-semibold text-blue-800 mb-2">💰 客户成交价(整单)
          <span className="ml-2 text-xs font-normal text-blue-600">本单未录逐款明细 → 先按整单录:填客户单价(¥/{qtyUnit})保存即可完成 PI;逐款价可后补</span>
        </div>
        <div className="flex items-center gap-2">
          <input type="number" min="0" step="0.01" value={orderPrice} onChange={(e) => setOrderPrice(e.target.value)}
            placeholder={`成交价 ¥/${qtyUnit}`} className="w-36 rounded border border-blue-300 px-2 py-1 text-sm" />
          <button onClick={async () => {
            setSaving(true); setMsg('');
            const res = await saveOrderDealPrices(orderId, [], orderPrice === '' ? null : orderPrice);
            setSaving(false);
            if (res.error) { setMsg(res.error); return; }
            setMsg('✅ 已保存,可点下方「确认完成」'); router.refresh();
          }} disabled={saving || orderPrice === ''} className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? '保存中…' : '保存成交价'}
          </button>
          {msg && <span className="text-xs text-gray-600">{msg}</span>}
        </div>
      </div>
    );
  }

  const allFilled = styles.every((s) => s.po_unit_price !== '' && Number(s.po_unit_price) > 0);
  const setPrice = (i: number, v: string) => setStyles((prev) => prev!.map((s, j) => (j === i ? { ...s, po_unit_price: v } : s)));

  async function save() {
    setSaving(true); setMsg('');
    const res = await saveOrderDealPrices(orderId, styles!.map((s) => ({ style_no: s.style_no, po_unit_price: s.po_unit_price === '' ? null : s.po_unit_price })));
    setSaving(false);
    if (res.error) { setMsg(res.error); return; }
    setMsg('✅ 成交价已保存,可点下方「确认完成」');
    router.refresh();
  }

  return (
    <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-4 mb-4">
      <div className="text-sm font-semibold text-blue-800 mb-2 flex items-center gap-2">
        💰 客户成交价(逐款)
        <span className="text-xs font-normal text-blue-600">—— 完成 PI 前必录;填客户单价(¥/件)后保存,即可点下方完成(经销单已录则自动带出)</span>
      </div>
      <div className="flex flex-col gap-2">
        {styles.map((s, i) => (
          <div key={s.style_no} className="flex items-center gap-2 text-sm">
            <span className="w-48 shrink-0 truncate text-gray-700" title={`${s.style_no}${s.product_name ? ' · ' + s.product_name : ''}`}>
              <b>{s.style_no}</b>{s.product_name ? ` · ${s.product_name}` : ''}
            </span>
            <input type="number" min="0" step="0.01" value={s.po_unit_price} onChange={(e) => setPrice(i, e.target.value)}
              placeholder="成交价 ¥/件" className="w-32 rounded border border-blue-300 px-2 py-1 text-sm" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving} className="text-xs px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {saving ? '保存中…' : '保存成交价'}
        </button>
        {!allFilled && <span className="text-xs text-amber-600">还有款未填价</span>}
        {msg && <span className="text-xs text-gray-600">{msg}</span>}
      </div>
    </div>
  );
}
