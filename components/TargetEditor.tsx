'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setCustomerTarget } from '@/app/actions/sales-targets';
import { createCustomer } from '@/app/actions/customers';

interface Props {
  year: number;
  customers: { id: string; customer_name: string }[];
}

const NEW_CUSTOMER_SENTINEL = '__new__';

export function TargetEditor({ year, customers: initialCustomers }: Props) {
  const router = useRouter();
  const [customers, setCustomers] = useState(initialCustomers);
  const [customerId, setCustomerId] = useState('');
  const [qtyWan, setQtyWan] = useState(''); // 输入单位：万件
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 新建客户面板
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const handleSelectChange = (val: string) => {
    if (val === NEW_CUSTOMER_SENTINEL) {
      setShowNewCustomer(true);
      setCustomerId('');
    } else {
      setCustomerId(val);
      setShowNewCustomer(false);
    }
  };

  const handleCreateCustomer = async () => {
    const name = newCustomerName.trim();
    if (!name) { setMsg('❌ 请填写客户名称'); return; }
    setCreatingCustomer(true);
    setMsg(null);
    try {
      const res = await createCustomer(name);
      if (res.error || !res.data) {
        setMsg('❌ ' + (res.error || '创建失败'));
        return;
      }
      // 把新客户加进列表并选中
      const newC = { id: res.data.id, customer_name: res.data.customer_name };
      setCustomers(prev => [...prev, newC].sort((a, b) => a.customer_name.localeCompare(b.customer_name)));
      setCustomerId(newC.id);
      setShowNewCustomer(false);
      setNewCustomerName('');
      setMsg(`✅ 新客户「${name}」已创建，可以设置目标了`);
    } catch (e: any) {
      setMsg('❌ ' + (e?.message || '创建失败'));
    } finally {
      setCreatingCustomer(false);
    }
  };

  const handleSave = async () => {
    setMsg(null);
    if (!customerId) { setMsg('❌ 请选择客户'); return; }
    const wan = parseFloat(qtyWan);
    if (!wan || wan <= 0) { setMsg('❌ 目标件数需大于 0（单位：万件）'); return; }

    const targetQty = Math.round(wan * 10000);
    setSaving(true);
    try {
      const res = await setCustomerTarget(customerId, year, targetQty, notes);
      if (res.error) {
        setMsg('❌ ' + res.error);
      } else {
        setMsg(`✅ 已保存：${targetQty.toLocaleString('zh-CN')} 件`);
        setCustomerId('');
        setQtyWan('');
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
          onChange={(e) => handleSelectChange(e.target.value)}
          className="md:col-span-4 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">— 选择客户 —</option>
          {customers.map(c => (
            <option key={c.id} value={c.id}>{c.customer_name}</option>
          ))}
          <option value={NEW_CUSTOMER_SENTINEL}>➕ 新建客户...</option>
        </select>

        <div className="md:col-span-3 relative">
          <input
            type="number"
            min={0}
            step={0.1}
            value={qtyWan}
            onChange={(e) => setQtyWan(e.target.value)}
            placeholder="目标件数"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-10 text-sm"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">万件</span>
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

      {/* 新建客户内联面板 */}
      {showNewCustomer && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-indigo-800">新建客户：</span>
          <input
            type="text"
            value={newCustomerName}
            onChange={(e) => setNewCustomerName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateCustomer(); } }}
            placeholder="客户名称（必填）"
            autoFocus
            className="flex-1 min-w-[200px] rounded-lg border border-indigo-300 px-3 py-2 text-sm bg-white"
          />
          <button
            onClick={handleCreateCustomer}
            disabled={creatingCustomer || !newCustomerName.trim()}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-3 py-2 disabled:opacity-50"
          >
            {creatingCustomer ? '创建中…' : '✓ 创建并选中'}
          </button>
          <button
            onClick={() => { setShowNewCustomer(false); setNewCustomerName(''); }}
            className="rounded-lg border border-gray-300 bg-white text-sm text-gray-700 px-3 py-2 hover:bg-gray-50"
          >
            取消
          </button>
        </div>
      )}

      {msg && <p className="text-xs text-gray-600">{msg}</p>}
      <p className="text-xs text-gray-400">
        农历 {year} 年（春节起算）· 同一客户重复保存会覆盖原目标 · 仅 admin 可操作
      </p>
    </div>
  );
}
