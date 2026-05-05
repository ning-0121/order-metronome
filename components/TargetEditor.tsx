'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setCustomerTarget } from '@/app/actions/sales-targets';

interface Props {
  year: number;
  customers: { id: string; customer_name: string }[];
}

export function TargetEditor({ year, customers }: Props) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState('');
  const [amountWan, setAmountWan] = useState(''); // 输入单位：万元
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleSave = async () => {
    setMsg(null);
    if (!customerId) { setMsg('❌ 请选择客户'); return; }
    const wan = parseFloat(amountWan);
    if (!wan || wan <= 0) { setMsg('❌ 目标金额需大于 0（单位：万元）'); return; }

    setSaving(true);
    try {
      const res = await setCustomerTarget(customerId, year, wan * 10000, notes);
      if (res.error) {
        setMsg('❌ ' + res.error);
      } else {
        setMsg('✅ 已保存');
        setCustomerId('');
        setAmountWan('');
        setNotes('');
        router.refresh();
      }
    } catch (e: any) {
      setMsg('❌ ' + (e?.message || '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="md:col-span-4 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">— 选择客户 —</option>
          {customers.map(c => (
            <option key={c.id} value={c.id}>{c.customer_name}</option>
          ))}
        </select>

        <div className="md:col-span-3 relative">
          <input
            type="number"
            min={0}
            step={1}
            value={amountWan}
            onChange={(e) => setAmountWan(e.target.value)}
            placeholder="目标金额"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-10 text-sm"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">万元</span>
        </div>

        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="备注（可选）"
          className="md:col-span-3 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />

        <button
          onClick={handleSave}
          disabled={saving}
          className="md:col-span-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-3 py-2 disabled:opacity-50"
        >
          {saving ? '保存中…' : '💾 保存目标'}
        </button>
      </div>
      {msg && <p className="text-xs text-gray-600">{msg}</p>}
      <p className="text-xs text-gray-400">
        年度 {year} · 同一客户重复保存会覆盖原目标 · 仅 admin 可操作
      </p>
    </div>
  );
}
