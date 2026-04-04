'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { PRODUCT_CATEGORIES } from '@/app/actions/factories';

interface Factory {
  id: string;
  factory_name: string;
  contact_name?: string;
  phone?: string;
  city?: string;
  address?: string;
  category?: string;
  cooperation_status?: string;
  product_categories?: string[];
  worker_count?: number;
  monthly_capacity?: number;
  notes?: string;
}

const STATUS_OPTIONS = [
  { value: 'active', label: '合作中', cls: 'bg-green-100 text-green-700' },
  { value: 'trial', label: '试用中', cls: 'bg-blue-100 text-blue-700' },
  { value: 'suspended', label: '暂停', cls: 'bg-amber-100 text-amber-700' },
  { value: 'blacklisted', label: '黑名单', cls: 'bg-red-100 text-red-700' },
];

export function FactoryManager({ factories, statsMap, canEdit }: {
  factories: Factory[];
  statsMap: Record<string, { active: number; completed: number }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  function startEdit(f: Factory) {
    setEditingId(f.id);
    setForm({
      contact_name: f.contact_name || '',
      phone: f.phone || '',
      city: f.city || '',
      address: f.address || '',
      cooperation_status: f.cooperation_status || 'active',
      product_categories: Array.isArray(f.product_categories) ? f.product_categories : [],
      worker_count: f.worker_count || '',
      monthly_capacity: f.monthly_capacity || '',
      notes: f.notes || '',
    });
  }

  function toggleCategory(cat: string) {
    setForm(f => {
      const cats = Array.isArray(f.product_categories) ? f.product_categories : [];
      return {
        ...f,
        product_categories: cats.includes(cat) ? cats.filter((c: string) => c !== cat) : [...cats, cat],
      };
    });
  }

  async function handleSave(factoryId: string) {
    setSaving(true);
    const supabase = createClient();
    await (supabase.from('factories') as any).update({
      contact_name: form.contact_name || null,
      phone: form.phone || null,
      city: form.city || null,
      address: form.address || null,
      cooperation_status: form.cooperation_status || 'active',
      product_categories: form.product_categories,
      worker_count: form.worker_count ? parseInt(form.worker_count) : null,
      monthly_capacity: form.monthly_capacity ? parseInt(form.monthly_capacity) : null,
      notes: form.notes || null,
    }).eq('id', factoryId);
    setEditingId(null);
    setSaving(false);
    router.refresh();
  }

  const filtered = factories.filter(f =>
    f.factory_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <input type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="搜索工厂..." className="w-full md:w-80 rounded-lg border border-gray-300 px-4 py-2 text-sm" />

      {filtered.map(f => {
        const stats = statsMap[f.factory_name] || { active: 0, completed: 0 };
        const isEditing = editingId === f.id;
        const statusCfg = STATUS_OPTIONS.find(s => s.value === f.cooperation_status) || STATUS_OPTIONS[0];

        return (
          <div key={f.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {isEditing ? (
              /* 编辑模式 */
              <div className="p-5 space-y-4">
                <h3 className="font-bold text-gray-900 text-lg">{f.factory_name}</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="text-xs text-gray-500">联系人</label>
                    <input value={form.contact_name} onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">电话</label>
                    <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">城市</label>
                    <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">合作状态</label>
                    <select value={form.cooperation_status} onChange={e => setForm(f => ({ ...f, cooperation_status: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                      {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">工人数</label>
                    <input type="number" value={form.worker_count} onChange={e => setForm(f => ({ ...f, worker_count: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500">月产能（件）</label>
                    <input type="number" value={form.monthly_capacity} onChange={e => setForm(f => ({ ...f, monthly_capacity: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500">地址</label>
                    <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1.5 block">生产品类</label>
                  <div className="flex flex-wrap gap-1.5">
                    {PRODUCT_CATEGORIES.map(cat => (
                      <button key={cat} type="button" onClick={() => toggleCategory(cat)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
                          (Array.isArray(form.product_categories) && form.product_categories.includes(cat)) ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'bg-white border-gray-200 text-gray-600'
                        }`}>{cat}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-500">备注</label>
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    rows={2} className="w-full mt-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                </div>
                <div className="flex gap-2 pt-2 border-t">
                  <button onClick={() => handleSave(f.id)} disabled={saving}
                    className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">
                    {saving ? '保存中...' : '保存'}
                  </button>
                  <button onClick={() => setEditingId(null)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600">取消</button>
                </div>
              </div>
            ) : (
              /* 展示模式 */
              <div className="px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-lg">🏭</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-gray-900">{f.factory_name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusCfg.cls}`}>{statusCfg.label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-gray-500 mt-0.5 flex-wrap">
                      {f.city && <span>{f.city}</span>}
                      {f.contact_name && <span>{f.contact_name}</span>}
                      {f.worker_count && <span>{f.worker_count}人</span>}
                      {f.monthly_capacity && <span>月产能{f.monthly_capacity.toLocaleString()}件</span>}
                    </div>
                    {Array.isArray(f.product_categories) && f.product_categories.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {f.product_categories.map((c: string) => (
                          <span key={c} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="flex gap-2 text-center">
                    <div className="px-2">
                      <div className="text-lg font-bold text-blue-600">{stats.active}</div>
                      <div className="text-xs text-gray-400">进行中</div>
                    </div>
                    <div className="px-2">
                      <div className="text-lg font-bold text-green-600">{stats.completed}</div>
                      <div className="text-xs text-gray-400">已完成</div>
                    </div>
                  </div>
                  {canEdit && (
                    <button onClick={() => startEdit(f)} className="text-sm text-indigo-600 hover:underline">编辑</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {filtered.length === 0 && <div className="text-center py-12 text-gray-400">暂无工厂数据</div>}
    </div>
  );
}
