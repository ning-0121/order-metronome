'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OrderTemplate } from '@/app/actions/order-templates';
import {
  createOrderTemplate,
  updateOrderTemplate,
  deleteOrderTemplate,
} from '@/app/actions/order-templates';

// ── 常量 ────────────────────────────────────────────
const INCOTERM_LABELS: Record<string, string> = {
  FOB: 'FOB（离岸价）',
  DDP: 'DDP（完税后交货）',
  RMB_EX_TAX: '人民币不含税',
  RMB_INC_TAX: '人民币含税',
};
const DELIVERY_LABELS: Record<string, string> = {
  export: '出口（含订舱/报关/出运）',
  domestic: '送仓（国内送仓）',
};
const ORDER_TYPE_LABELS: Record<string, string> = {
  trial: '新品试单',
  bulk: '正常大货',
  repeat: '翻单',
  urgent: '加急订单',
};
const SAMPLE_PHASE_LABELS: Record<string, string> = {
  confirmed: '头样已确认',
  dev_sample: '需要做头样',
  dev_sample_with_revision: '头样 + 可能二次样',
  skip_all: '不需要产前样',
};
const RISK_FLAG_LABELS: Record<string, string> = {
  new_customer: '新客户首单',
  new_factory: '新工厂首单',
  has_plus_size: '大码款',
  high_stretch: '高弹面料',
  light_color_risk: '浅色风险',
  color_clash_risk: '撞色风险',
  complex_print: '复杂印花',
  tight_deadline: '交期紧急',
};

// ── 空白模板 ─────────────────────────────────────────
const BLANK: Partial<OrderTemplate> = {
  name: '',
  description: '',
  template_type: 'production',
  incoterm: 'FOB',
  delivery_type: 'export',
  order_type: 'bulk',
  sample_phase: 'confirmed',
  sample_confirm_days_override: null,
  shipping_sample_required: false,
  risk_flags: [],
  default_notes: '',
  is_active: true,
  sort_order: 0,
};

// ── 主组件 ───────────────────────────────────────────
export function OrderTemplatesClient({ initialTemplates }: { initialTemplates: OrderTemplate[] }) {
  const router = useRouter();
  const [templates, setTemplates] = useState<OrderTemplate[]>(initialTemplates);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<OrderTemplate>>(BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function openNew() {
    setForm({ ...BLANK });
    setEditingId(null);
    setShowForm(true);
    setError('');
  }

  function openEdit(t: OrderTemplate) {
    setForm({ ...t });
    setEditingId(t.id);
    setShowForm(true);
    setError('');
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setError('');
  }

  async function handleSave() {
    if (!form.name?.trim()) {
      setError('请填写模板名称');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        const res = await updateOrderTemplate(editingId, form);
        if (!res.ok) { setError(res.error || '保存失败'); return; }
      } else {
        const res = await createOrderTemplate(form);
        if (!res.ok) { setError(res.error || '创建失败'); return; }
      }
      router.refresh();
      closeForm();
      // 乐观更新列表
      if (editingId) {
        setTemplates(prev => prev.map(t => t.id === editingId ? { ...t, ...form } as OrderTemplate : t));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(t: OrderTemplate) {
    await updateOrderTemplate(t.id, { is_active: !t.is_active });
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, is_active: !x.is_active } : x));
  }

  async function handleDelete(t: OrderTemplate) {
    if (!confirm(`确定删除模板「${t.name}」？此操作不可恢复。`)) return;
    await deleteOrderTemplate(t.id);
    setTemplates(prev => prev.filter(x => x.id !== t.id));
  }

  function toggleRiskFlag(flag: string) {
    const flags = form.risk_flags || [];
    setForm(prev => ({
      ...prev,
      risk_flags: flags.includes(flag) ? flags.filter(f => f !== flag) : [...flags, flag],
    }));
  }

  const active = templates.filter(t => t.is_active);
  const inactive = templates.filter(t => !t.is_active);

  return (
    <div className="space-y-6">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          共 <span className="font-semibold">{templates.length}</span> 个模板，其中 <span className="font-semibold text-green-600">{active.length}</span> 个启用
        </p>
        <button
          onClick={openNew}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <span>+</span> 新建模板
        </button>
      </div>

      {/* 模板列表 */}
      <div className="space-y-3">
        {active.map(t => (
          <TemplateCard key={t.id} t={t} onEdit={() => openEdit(t)} onToggle={() => handleToggleActive(t)} onDelete={() => handleDelete(t)} />
        ))}
        {inactive.length > 0 && (
          <details className="mt-4">
            <summary className="text-sm text-gray-400 cursor-pointer hover:text-gray-600 select-none">
              已停用模板（{inactive.length} 个）
            </summary>
            <div className="mt-2 space-y-2 opacity-60">
              {inactive.map(t => (
                <TemplateCard key={t.id} t={t} onEdit={() => openEdit(t)} onToggle={() => handleToggleActive(t)} onDelete={() => handleDelete(t)} />
              ))}
            </div>
          </details>
        )}
        {templates.length === 0 && (
          <div className="text-center py-12 text-gray-400 text-sm">
            暂无模板，点击右上角「新建模板」创建第一个
          </div>
        )}
      </div>

      {/* 新建/编辑表单弹层 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between rounded-t-2xl">
              <h2 className="text-lg font-bold text-gray-900">
                {editingId ? '编辑模板' : '新建模板'}
              </h2>
              <button onClick={closeForm} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* 模板名称 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  模板名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.name || ''}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="如：欧美 FOB 出口标准、国内含税送仓..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                />
              </div>

              {/* 说明 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">模板说明（可选）</label>
                <input
                  type="text"
                  value={form.description || ''}
                  onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="简要说明适用场景"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                />
              </div>

              {/* 模板类型 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">模板类型</label>
                <div className="flex gap-3">
                  {(['production', 'sample'] as const).map(t => (
                    <label key={t} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm transition-colors ${form.template_type === t ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                      <input type="radio" name="template_type" value={t} checked={form.template_type === t} onChange={() => setForm(p => ({ ...p, template_type: t }))} className="hidden" />
                      {t === 'production' ? '🏭 大货单' : '🧵 样品单'}
                    </label>
                  ))}
                </div>
              </div>

              {/* 贸易条款 + 交付方式 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">贸易条款</label>
                  <select
                    value={form.incoterm || ''}
                    onChange={e => {
                      const v = e.target.value;
                      setForm(p => ({
                        ...p,
                        incoterm: v || null,
                        delivery_type: v === 'DDP' ? 'export' : (v ? 'domestic' : p.delivery_type),
                      }));
                    }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                  >
                    <option value="">不指定</option>
                    {Object.entries(INCOTERM_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">交付方式</label>
                  <select
                    value={form.delivery_type || ''}
                    onChange={e => setForm(p => ({ ...p, delivery_type: e.target.value || null }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                  >
                    <option value="">不指定</option>
                    {Object.entries(DELIVERY_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 订单类型 + 样品阶段 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">默认订单类型</label>
                  <select
                    value={form.order_type || ''}
                    onChange={e => setForm(p => ({ ...p, order_type: e.target.value || null }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                  >
                    <option value="">不指定</option>
                    {Object.entries(ORDER_TYPE_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">样品阶段</label>
                  <select
                    value={form.sample_phase || ''}
                    onChange={e => setForm(p => ({ ...p, sample_phase: e.target.value || null }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                  >
                    <option value="">不指定</option>
                    {Object.entries(SAMPLE_PHASE_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 样品确认天数 + 船样 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    样品确认预留天数
                  </label>
                  <input
                    type="number" min="7" max="60"
                    value={form.sample_confirm_days_override || ''}
                    onChange={e => setForm(p => ({ ...p, sample_confirm_days_override: e.target.value ? parseInt(e.target.value) : null }))}
                    placeholder="留空 = 使用系统默认（19天）"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shipping Sample</label>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.shipping_sample_required || false}
                      onChange={e => setForm(p => ({ ...p, shipping_sample_required: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600"
                    />
                    <span className="text-sm text-gray-700">默认需要船样</span>
                  </label>
                </div>
              </div>

              {/* 风险标记 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">默认风险标记</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {Object.entries(RISK_FLAG_LABELS).map(([flag, label]) => (
                    <label key={flag}
                      className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${(form.risk_flags || []).includes(flag) ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                      <input type="checkbox" className="hidden"
                        checked={(form.risk_flags || []).includes(flag)}
                        onChange={() => toggleRiskFlag(flag)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* 默认备注 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">默认备注（可选）</label>
                <textarea
                  rows={3}
                  value={form.default_notes || ''}
                  onChange={e => setForm(p => ({ ...p, default_notes: e.target.value }))}
                  placeholder="套用此模板时自动填入订单备注..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                />
              </div>

              {/* 排序 + 状态 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">排序权重（越小越靠前）</label>
                  <input
                    type="number" min="0"
                    value={form.sort_order ?? 0}
                    onChange={e => setForm(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.is_active !== false}
                      onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-300 text-green-600"
                    />
                    <span className="text-sm text-gray-700">启用此模板</span>
                  </label>
                </div>
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                  {error}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4 flex gap-3 rounded-b-2xl">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? '保存中...' : editingId ? '💾 保存更改' : '✅ 创建模板'}
              </button>
              <button
                onClick={closeForm}
                className="px-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 模板卡片 ────────────────────────────────────────
function TemplateCard({
  t,
  onEdit,
  onToggle,
  onDelete,
}: {
  t: OrderTemplate;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const tags: string[] = [];
  if (t.incoterm) tags.push(t.incoterm);
  if (t.delivery_type === 'export') tags.push('出口');
  if (t.delivery_type === 'domestic') tags.push('送仓');
  if (t.order_type) tags.push(t.order_type === 'bulk' ? '大货' : t.order_type === 'trial' ? '试单' : t.order_type === 'repeat' ? '翻单' : '加急');
  if (t.shipping_sample_required) tags.push('需船样');

  return (
    <div className={`rounded-xl border p-4 flex items-start gap-4 ${t.is_active ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50'}`}>
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-xl">
        {t.template_type === 'sample' ? '🧵' : '📦'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-gray-900 text-sm">{t.name}</h3>
          {!t.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500">已停用</span>}
          <span className="text-[10px] text-gray-400 ml-auto">使用 {t.usage_count} 次</span>
        </div>
        {t.description && <p className="text-xs text-gray-500 mt-0.5">{t.description}</p>}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {tags.map(tag => (
            <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
              {tag}
            </span>
          ))}
          {(t.risk_flags || []).map(flag => (
            <span key={flag} className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
              {flag === 'new_customer' ? '新客户' : flag === 'new_factory' ? '新工厂' : flag === 'tight_deadline' ? '交期紧' : flag}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button onClick={onEdit} className="text-xs text-indigo-600 hover:underline px-2 py-1 rounded hover:bg-indigo-50">
          编辑
        </button>
        <button onClick={onToggle} className={`text-xs px-2 py-1 rounded hover:bg-gray-50 ${t.is_active ? 'text-amber-600' : 'text-green-600'}`}>
          {t.is_active ? '停用' : '启用'}
        </button>
        <button onClick={onDelete} className="text-xs text-red-500 hover:underline px-2 py-1 rounded hover:bg-red-50">
          删除
        </button>
      </div>
    </div>
  );
}
