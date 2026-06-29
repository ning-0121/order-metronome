'use client';
import { useEffect, useState } from 'react';
import {
  getManufacturingOrder, upsertManufacturingOrder, updateManufacturingOrderStatus,
  generateManufacturingOrderSheet,
} from '@/app/actions/manufacturing-order';

const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', lining: '里料', label: '标签', packing: '包装',
  print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};
const STATUS_FLOW = [
  { key: 'draft', label: '草稿' }, { key: 'reviewing', label: '复核中' },
  { key: 'confirmed', label: '已确认' }, { key: 'executing', label: '已下发生产' }, { key: 'closed', label: '完成' },
];
const statusLabel = (s: string) => STATUS_FLOW.find(x => x.key === s)?.label || s;

const emptyForm = {
  print_embroidery_requirements: '', qc_focus: '', special_requirements: '',
  risk_notes: '', factory_packing_instructions: '', factory_notes: '',
};

export function ManufacturingOrderTab({ orderId }: { orderId: string }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  const reload = async () => {
    const res = await getManufacturingOrder(orderId);
    if ((res as any).error) { setMsg((res as any).error); setLoading(false); return; }
    const d = (res as any).data;
    setData(d);
    if (d.mo) {
      setForm({
        print_embroidery_requirements: d.mo.print_embroidery_requirements || '',
        qc_focus: d.mo.qc_focus || '', special_requirements: d.mo.special_requirements || '',
        risk_notes: d.mo.risk_notes || '', factory_packing_instructions: d.mo.factory_packing_instructions || '',
        factory_notes: d.mo.factory_notes || '',
      });
    }
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setMsg('');
    const res = await upsertManufacturingOrder(orderId, form);
    setSaving(false);
    if ((res as any).error) { setMsg('保存失败：' + (res as any).error); return; }
    setMsg('✅ 已保存');
    await reload();
  }

  async function advance(status: string) {
    setStatusBusy(true); setMsg('');
    const res = await updateManufacturingOrderStatus(orderId, status as any);
    setStatusBusy(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    await reload();
  }

  async function generate() {
    setGenerating(true); setMsg('');
    try {
      const res = await generateManufacturingOrderSheet(orderId);
      if ((res as any).error) { setMsg((res as any).error); return; }
      const { base64, fileName } = res as any;
      const bytes = atob(base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e: any) { setMsg('生成出错：' + (e?.message || e)); }
    finally { setGenerating(false); }
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!data) return <div className="text-center py-8 text-red-500">{msg || '加载失败'}</div>;

  const { mo, order, lineItems, bom } = data;
  const status = mo?.status || null;

  const field = (label: string, key: keyof typeof emptyForm, ph = '', rows = 2) => (
    <label className="text-xs text-gray-600 block">{label}
      <textarea value={form[key]} onChange={e => set(key, e.target.value)} placeholder={ph} rows={rows}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-y" />
    </label>
  );

  return (
    <div className="space-y-5">
      {/* 顶部:MO 号 + 生命周期 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-mono font-semibold text-gray-900">{mo?.mo_no || '生产任务单（未创建）'}</span>
          {status && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{statusLabel(status)}</span>}
        </div>
        <button onClick={generate} disabled={generating || !mo}
          className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">
          {generating ? '生成中…' : '📄 生成生产任务单'}</button>
      </div>

      {/* 生命周期条 */}
      {mo && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_FLOW.map((s, i) => {
            const idx = STATUS_FLOW.findIndex(x => x.key === status);
            const done = i <= idx;
            return (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={`text-xs px-2 py-0.5 rounded-full ${done ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-400'}`}>{s.label}</span>
                {i < STATUS_FLOW.length - 1 && <span className="text-gray-300">›</span>}
              </span>
            );
          })}
          <span className="ml-auto flex gap-2">
            {(status === 'draft' || status === 'reviewing') && (
              <button onClick={() => advance('confirmed')} disabled={statusBusy}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">✅ 确认</button>
            )}
            {status === 'confirmed' && (
              <button onClick={() => advance('executing')} disabled={statusBusy}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">🏭 下发生产</button>
            )}
            {status === 'executing' && (
              <button onClick={() => advance('closed')} disabled={statusBusy}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50 disabled:opacity-50">完成</button>
            )}
          </span>
        </div>
      )}

      {/* Customer Order 绑定(只读,单一真相不复制)*/}
      <div className="rounded-xl border border-gray-200 p-4 bg-gray-50/50">
        <div className="text-xs font-semibold text-gray-500 mb-2">客户订单（绑定 · 只读）</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
          <div><span className="text-gray-400">客户：</span>{order.customer_name || '—'}</div>
          <div><span className="text-gray-400">订单号：</span>{order.order_no || '—'}</div>
          <div><span className="text-gray-400">款号：</span>{order.style_no || '—'}</div>
          <div><span className="text-gray-400">产品：</span>{order.product_name || '—'}</div>
          <div><span className="text-gray-400">数量：</span>{order.quantity ?? '—'}</div>
          <div><span className="text-gray-400">工厂交期：</span>{order.factory_date ? String(order.factory_date).slice(0, 10) : '—'}</div>
        </div>
        {order.packing_requirement && (
          <div className="mt-2 text-xs text-gray-500"><span className="text-gray-400">客户原始包装要求：</span>{order.packing_requirement}</div>
        )}
      </div>

      {/* 款色码 + 原辅料包摘要 */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">款 × 色 × 码（{lineItems.length}）</div>
          {lineItems.length === 0 ? <p className="text-xs text-gray-400">无明细</p> : (
            <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
              {lineItems.map((li: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="text-gray-700 shrink-0">{[li.color_cn, li.color_en].filter(Boolean).join('/') || '—'}</span>
                  <span className="text-gray-400 truncate">{li.sizes && typeof li.sizes === 'object' ? Object.entries(li.sizes).map(([k, v]) => `${k}:${v}`).join(' ') : ''}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{li.qty_pcs ?? '—'} {li.unit || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">原辅料包（{bom.length}）</div>
          {bom.length === 0 ? <p className="text-xs text-gray-400">无明细（去「原辅料和包装」录入）</p> : (
            <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
              {bom.map((b: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="font-medium text-gray-800 shrink-0">{b.material_name}</span>
                  <span className="text-blue-600 shrink-0">{CAT_LABEL[b.material_type] || b.material_type}</span>
                  <span className="text-gray-400 truncate">{b.color || ''} {b.placement || ''}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{b.qty_per_piece ?? '—'} {b.unit || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MO 录入字段(业务翻译给工厂执行)*/}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
        <div className="text-xs font-semibold text-gray-600">工厂执行说明（业务翻译，结构化录入）</div>
        <div className="grid md:grid-cols-2 gap-3">
          {field('印绣要求', 'print_embroidery_requirements')}
          {field('QC 重点', 'qc_focus')}
          {field('特殊要求', 'special_requirements')}
          {field('风险提醒', 'risk_notes')}
          {field('内部包装说明（≠客户原始要求）', 'factory_packing_instructions')}
          {field('其他下厂说明', 'factory_notes')}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中…' : mo ? '保存' : '创建生产任务单'}</button>
          {msg && <span className="text-xs text-gray-500">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
