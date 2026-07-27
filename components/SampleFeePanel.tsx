'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSampleFee, saveSampleFee, SAMPLE_FEE_BEARERS } from '@/app/actions/sample-fee';

/** 打样费录入(2026-07-27 CEO):打样单专属,记金额+承担方。仅财务/业务/admin 可编辑;非打样单/无权不渲染。 */
export function SampleFeePanel({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [show, setShow] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [amount, setAmount] = useState('');
  const [bearer, setBearer] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    getSampleFee(orderId).then((r) => {
      if (!alive) return;
      setLoaded(true);
      if (r.error) return;
      // canEdit undefined 或 amount/bearer 有值都说明是打样单;非打样单返回 { canEdit:false } 且无 amount → 不渲染
      const isSample = r.canEdit !== undefined || r.amount != null || r.bearer != null;
      setShow(isSample);
      setCanEdit(!!r.canEdit);
      setAmount(r.amount != null ? String(r.amount) : '');
      setBearer(r.bearer || '');
    });
    return () => { alive = false; };
  }, [orderId]);

  if (!loaded || !show) return null;

  async function save() {
    setSaving(true); setMsg('');
    const res = await saveSampleFee(orderId, amount === '' ? null : Number(amount), bearer || null);
    setSaving(false);
    if (res.error) { setMsg(res.error); return; }
    setMsg('✅ 已保存');
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="text-sm font-semibold text-amber-900 mb-2">💰 打样费</div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="text-gray-600">金额 ¥</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="打样费" className="w-28 rounded border border-amber-300 px-2 py-1" />
          <label className="text-gray-600 ml-2">承担方</label>
          <select value={bearer} onChange={(e) => setBearer(e.target.value)} className="rounded border border-amber-300 px-2 py-1 bg-white">
            <option value="">— 选择 —</option>
            {Object.entries(SAMPLE_FEE_BEARERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={save} disabled={saving} className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">{saving ? '保存中…' : '保存'}</button>
          {msg && <span className="text-xs text-gray-600">{msg}</span>}
        </div>
      ) : (
        <div className="text-sm text-gray-700">
          {amount ? `¥${amount}` : '未录'} · 承担方:{bearer ? SAMPLE_FEE_BEARERS[bearer] || bearer : '未定'}
          <span className="text-xs text-gray-400 ml-2">(仅财务/业务/管理员可编辑)</span>
        </div>
      )}
    </div>
  );
}
