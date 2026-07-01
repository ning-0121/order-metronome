'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupplier, updateSupplier } from '@/app/actions/suppliers';

const EMPTY = { name: '', address: '', phone: '', contact_name: '', main_category: '', payment_method: '', net_days: '', bank_info: '', tax_id: '' };

export function SuppliersClient({ suppliers, canBasic, canFinance, error }: {
  suppliers: any[]; canBasic: boolean; canFinance: boolean; error?: string;
}) {
  const router = useRouter();
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<any>(EMPTY);
  const [saving, setSaving] = useState(false);

  function loadRow(s: any) {
    setEditId(s.id);
    setForm({
      name: s.name || '', address: s.address || '', phone: s.phone || '', contact_name: s.contact_name || '',
      main_category: s.main_category || '', payment_method: s.payment_method || '', net_days: s.net_days ?? '',
      bank_info: s.bank_info || '', tax_id: s.tax_id || '',
    });
  }
  function reset() { setEditId(null); setForm(EMPTY); }

  async function save() {
    setSaving(true);
    const payload: any = { ...form, net_days: form.net_days === '' ? null : Number(form.net_days) };
    const res = editId ? await updateSupplier(editId, payload) : await createSupplier(payload);
    setSaving(false);
    if ((res as any).error) { alert((res as any).error); return; }
    reset();
    router.refresh();
  }

  const field = (key: string, label: string, editable: boolean, type = 'text') => (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}{!editable && <span className="text-gray-300"> (无编辑权)</span>}</label>
      <input type={type} value={form[key]} disabled={!editable}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400" />
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* 表单 */}
      <div className="space-y-4">
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">{editId ? '编辑供应商' : '新建供应商'}</h2>
          <div className="grid grid-cols-2 gap-3">
            {field('name', '名称 *', canBasic)}
            {field('main_category', '主营品类', canBasic)}
            {field('contact_name', '联系人', canBasic)}
            {field('phone', '电话', canBasic)}
          </div>
          {field('address', '地址', canBasic)}
          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-gray-600 mb-2">💰 财务条款（财务填）</p>
            <div className="grid grid-cols-2 gap-3">
              {field('payment_method', '付款方式', canFinance)}
              {field('net_days', '账期(天)', canFinance, 'number')}
              {field('bank_info', '银行信息', canFinance)}
              {field('tax_id', '税号', canFinance)}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving || (!canBasic && !canFinance)}
              className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
              {saving ? '保存中…' : editId ? '保存修改' : '创建供应商'}
            </button>
            {editId && <button onClick={reset} className="px-4 rounded-xl border border-gray-200 text-sm text-gray-500">取消</button>}
          </div>
        </section>
      </div>

      {/* 列表 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">供应商 {suppliers.length}</div>
        {error ? <div className="p-6 text-sm text-red-600">{error}</div>
          : suppliers.length === 0 ? <div className="p-6 text-sm text-gray-400">暂无供应商</div>
          : (
          <div className="divide-y divide-gray-100 max-h-[560px] overflow-auto">
            {suppliers.map((s) => (
              <button key={s.id} onClick={() => loadRow(s)}
                className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${editId === s.id ? 'bg-indigo-50' : ''}`}>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-900">{s.name}</span>
                  <span className="text-xs text-gray-400">{s.main_category || '—'}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {s.contact_name || ''} {s.phone || ''} · 账期 {s.net_days != null ? s.net_days + '天' : '—'}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
