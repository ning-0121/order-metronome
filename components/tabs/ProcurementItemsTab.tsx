'use client';
import { useEffect, useState } from 'react';
import {
  listProcurementItems, consolidateOrderProcurementItems, getProcurementItemSources,
  updateProcurementItem, updateProcurementItemStatus,
} from '@/app/actions/procurement-items';

const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', packing: '包装', print: '印花',
  washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};
const STATUS_FLOW = [
  { key: 'draft', label: '草稿' }, { key: 'reviewing', label: '复核中' }, { key: 'confirmed', label: '已确认' },
  { key: 'ordered', label: '已下单' }, { key: 'partially_received', label: '部分到货' },
  { key: 'completed', label: '完成' }, { key: 'closed', label: '关闭' },
];
const statusLabel = (s: string) => STATUS_FLOW.find(x => x.key === s)?.label || s;

const FORM_KEYS = [
  'production_consumption', 'procurement_loss_pct', 'safety_stock_qty', 'moq', 'purchase_unit', 'final_purchase_qty',
  'confirmed_supplier_name', 'backup_supplier_name', 'supplier_contact', 'lead_days',
  'unit_price', 'currency', 'tax_rate', 'price_inclusive_tax', 'quote_date',
  'is_substitute', 'substitute_reason', 'is_split', 'is_outsourced', 'risk_flag', 'risk_note', 'procurement_notes',
];

export function ProcurementItemsTab({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    const res = await listProcurementItems(orderId);
    if ((res as any).error) { setMsg((res as any).error); }
    else setItems((res as any).data || []);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);

  async function consolidate() {
    setBusy(true); setMsg('');
    const res = await consolidateOrderProcurementItems(orderId);
    setBusy(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(`✅ 核料完成:新增 ${(res as any).created} / 刷新 ${(res as any).updated}${(res as any).flagged ? ` / 标记需重确认 ${(res as any).flagged}` : ''}`);
    await reload();
  }

  async function select(item: any) {
    if (selId === item.id) { setSelId(null); return; }
    setSelId(item.id); setSources([]);
    const f: Record<string, any> = {};
    for (const k of FORM_KEYS) f[k] = item[k] ?? '';
    setForm(f);
    const res = await getProcurementItemSources(item.id);
    if ((res as any).data) setSources((res as any).data);
  }
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!selId) return;
    setSaving(true); setMsg('');
    const res = await updateProcurementItem(selId, orderId, form);
    setSaving(false);
    if ((res as any).error) { setMsg('保存失败：' + (res as any).error); return; }
    setMsg('✅ 已保存'); await reload();
  }
  async function advance(status: string) {
    if (!selId) return;
    setSaving(true); setMsg('');
    const res = await updateProcurementItemStatus(selId, orderId, status);
    setSaving(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    await reload();
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  const sel = items.find(i => i.id === selId);

  return (
    <div className="space-y-4">
      {/* 顶部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-500">{items.length} 个采购核料项 · 同订单按 物料+颜色+单位 自动归并</div>
        <button onClick={consolidate} disabled={busy}
          className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
          {busy ? '核料中…' : '🔄 核料归并 / 刷新'}</button>
      </div>
      {msg && <p className="text-xs text-gray-600">{msg}</p>}

      {items.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <p className="mb-2">暂无采购核料项</p>
          <button onClick={consolidate} disabled={busy} className="text-indigo-600 text-sm font-medium hover:underline">🔄 从物料需求核料归并</button>
          <p className="text-[11px] text-gray-400 mt-2">需先在「原辅料和包装」提交采购、跑出 MRP 需求。</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 text-left text-gray-500">
              {['编号', '物料', '类别', '颜色', '单位', '总需求', '来源', '建议采购', '最终', '供应商', '状态', ''].map(h => (
                <th key={h} className="py-2 px-2 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className={`border-b border-gray-50 hover:bg-gray-50 cursor-pointer ${selId === it.id ? 'bg-indigo-50/40' : ''}`} onClick={() => select(it)}>
                  <td className="py-2 px-2 font-mono text-xs text-indigo-600 whitespace-nowrap">
                    {it.needs_reconfirm && <span title="需重新确认" className="text-amber-600">⚠ </span>}{it.item_no || '—'}</td>
                  <td className="py-2 px-2 font-medium text-gray-900">{it.material_name || '—'}</td>
                  <td className="py-2 px-2"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{CAT_LABEL[it.category] || it.category || '—'}</span></td>
                  <td className="py-2 px-2 text-gray-600">{it.color || '—'}</td>
                  <td className="py-2 px-2 text-gray-600">{it.unit || '—'}</td>
                  <td className="py-2 px-2 text-gray-700">{it.total_required_qty ?? '—'}</td>
                  <td className="py-2 px-2 text-gray-400">{it.source_count ?? '—'}</td>
                  <td className="py-2 px-2 text-gray-700">{it.suggested_purchase_qty ?? '—'}</td>
                  <td className="py-2 px-2 font-medium text-gray-900">{it.final_purchase_qty ?? '—'}</td>
                  <td className="py-2 px-2 text-gray-600 max-w-[120px] truncate">{it.confirmed_supplier_name || '—'}</td>
                  <td className="py-2 px-2"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{statusLabel(it.status)}</span></td>
                  <td className="py-2 px-2 text-xs text-indigo-600">{selId === it.id ? '收起' : '展开'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 展开:来源明细 + 采购确认 */}
      {sel && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-800">{sel.item_no} · {sel.material_name} {sel.color ? `· ${sel.color}` : ''}</div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">{statusLabel(sel.status)}</span>
          </div>

          {/* 来源明细(live;粒度=物料行)*/}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="text-xs font-semibold text-gray-500 mb-2">来源明细（{sources.length}）<span className="font-normal text-gray-400">· 暂到物料行粒度,产品拆分待 O 域</span></div>
            {sources.length === 0 ? <p className="text-xs text-gray-400">无来源</p> : (
              <table className="w-full text-xs">
                <thead><tr className="text-gray-400 text-left">{['物料', '颜色', '开发单耗', '需求量'].map(h => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{sources.map((s, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="py-1 pr-3 text-gray-700">{s.material_name || '—'}</td>
                    <td className="py-1 pr-3 text-gray-500">{s.color || '—'}</td>
                    <td className="py-1 pr-3 text-gray-500">{s.development_consumption ?? '—'}</td>
                    <td className="py-1 pr-3 text-gray-700">{s.net_demand ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>

          {/* 数量(系统算 + 采购确认)*/}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Read label="总需求(系统)" value={sel.total_required_qty} />
            <Read label="开发单耗(系统)" value={sel.development_consumption} />
            <Field label="大货单耗" k="production_consumption" form={form} set={set} type="number" />
            <Field label="采购损耗%" k="procurement_loss_pct" form={form} set={set} type="number" />
            <Field label="安全库存" k="safety_stock_qty" form={form} set={set} type="number" />
            <Field label="MOQ" k="moq" form={form} set={set} type="number" />
            <Read label="建议采购(系统算)" value={sel.suggested_purchase_qty} />
            <Field label="最终采购量" k="final_purchase_qty" form={form} set={set} type="number" />
          </div>

          {/* 供应商 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Field label="确认供应商" k="confirmed_supplier_name" form={form} set={set} />
            <Field label="备用供应商" k="backup_supplier_name" form={form} set={set} />
            <Field label="联系人" k="supplier_contact" form={form} set={set} />
            <Field label="Lead(天)" k="lead_days" form={form} set={set} type="number" />
            <Field label="采购单位" k="purchase_unit" form={form} set={set} />
          </div>

          {/* 价格 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Field label="单价" k="unit_price" form={form} set={set} type="number" />
            <Field label="币种" k="currency" form={form} set={set} />
            <Field label="税率%" k="tax_rate" form={form} set={set} type="number" />
            <Field label="报价日" k="quote_date" form={form} set={set} type="date" />
            <Check label="含税" k="price_inclusive_tax" form={form} set={set} />
          </div>

          {/* 决策 */}
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap gap-4">
              <Check label="替代" k="is_substitute" form={form} set={set} />
              <Check label="拆单" k="is_split" form={form} set={set} />
              <Check label="外协" k="is_outsourced" form={form} set={set} />
              <Check label="风险" k="risk_flag" form={form} set={set} />
            </div>
            <div className="grid md:grid-cols-3 gap-3">
              <Field label="替代原因" k="substitute_reason" form={form} set={set} />
              <Field label="风险说明" k="risk_note" form={form} set={set} />
              <Field label="采购备注" k="procurement_notes" form={form} set={set} />
            </div>
          </div>

          {/* 操作 */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button onClick={save} disabled={saving}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">{saving ? '保存中…' : '保存'}</button>
            {(sel.status === 'draft' || sel.status === 'reviewing') && (
              <button onClick={() => advance('confirmed')} disabled={saving}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">✅ 确认采购</button>
            )}
            {sel.status === 'draft' && (
              <button onClick={() => advance('reviewing')} disabled={saving}
                className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">转复核</button>
            )}
            {sel.needs_reconfirm && <span className="text-xs text-amber-600">⚠ 来源需求已变,确认即清除标记</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function Read({ label, value }: { label: string; value: any }) {
  return <div><div className="text-gray-400">{label}</div><div className="mt-1 px-2 py-1.5 rounded bg-gray-100 text-gray-700">{value ?? '—'}</div></div>;
}
function Field({ label, k, form, set, type = 'text' }: any) {
  return (
    <label className="text-gray-600">{label}
      <input type={type} value={form[k] ?? ''} onChange={e => set(k, e.target.value)}
        className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5" /></label>
  );
}
function Check({ label, k, form, set }: any) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-gray-600">
      <input type="checkbox" checked={!!form[k]} onChange={e => set(k, e.target.checked)} /> {label}
    </label>
  );
}
