'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createPurchaseOrder } from '@/app/actions/purchase-orders';
import { consolidationKey } from '@/lib/services/procurement-consolidation';
import { useDialogs } from '@/components/ui/useDialogs';

export function NewPurchaseOrderClient({ suppliers, lines }: { suppliers: any[]; lines: any[] }) {
  const router = useRouter();
  const { confirm, dialog } = useDialogs();
  const [supplierId, setSupplierId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [saving, setSaving] = useState(false);

  function toggle(id: string) {
    const n = new Set(checked);
    n.has(id) ? n.delete(id) : n.add(id);
    setChecked(n);
  }

  // C:勾选行里同 consolidation_key(名+规格+类别+单位;不同颜色不同 key)≥2 行 → 可合并组
  function duplicateGroups() {
    const groups = new Map<string, { label: string; count: number; qty: number; unit: string }>();
    for (const l of lines.filter((x) => checked.has(x.id))) {
      const key = consolidationKey({
        material_name: l.material_name, specification: l.specification,
        category: l.category, unit: l.ordered_unit,
      });
      const g = groups.get(key) || {
        label: `${l.material_name}${l.specification ? ' / ' + l.specification : ''}`,
        count: 0, qty: 0, unit: l.ordered_unit || '',
      };
      g.count += 1;
      g.qty += Number(l.ordered_qty) || 0;
      groups.set(key, g);
    }
    return [...groups.values()].filter((g) => g.count >= 2);
  }

  async function submit() {
    if (!supplierId) { await confirm({ title: '请选择供应商', confirmText: '知道了' }); return; }
    if (checked.size === 0) { await confirm({ title: '请勾选采购行', confirmText: '知道了' }); return; }

    let mergeSameMaterials = false;
    const dups = duplicateGroups();
    if (dups.length > 0) {
      const list = dups.map((g) => `· ${g.label}:${g.count} 行,共 ${Math.round(g.qty * 1000) / 1000} ${g.unit}`).join('\n');
      mergeSameMaterials = await confirm({
        title: `检测到 ${dups.length} 组同料同规格(同单位)采购行,是否合并?`,
        message: `${list}\n\n【合并】导出给供应商时并为一行(系统内仍分订单核销,不影响对账)\n【保持分行】不合并`,
        confirmText: '合并',
        cancelText: '保持分行',
      });
    }

    setSaving(true);
    const res = await createPurchaseOrder({ supplierId, lineItemIds: [...checked], paymentTerms, deliveryDate: deliveryDate || undefined, mergeSameMaterials });
    setSaving(false);
    if (res.error) { await confirm({ title: res.error, confirmText: '知道了' }); return; }
    router.push(`/procurement/po/${res.id}`);
  }

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-xl border border-gray-200 p-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">供应商 *</label>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">— 选择供应商 —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {suppliers.length === 0 && <p className="text-xs text-amber-600 mt-1">还没有供应商,<Link href="/suppliers" className="underline">先去建</Link></p>}
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">付款方式</label>
          <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">交期</label>
          <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">待归单采购项 {lines.length}（勾选）</div>
        {lines.length === 0 ? <div className="p-6 text-sm text-gray-400">暂无待归单采购项</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-3 py-2"></th><th className="px-3 py-2">物料</th><th className="px-3 py-2">规格</th>
                <th className="px-3 py-2 text-center">数量</th><th className="px-3 py-2 text-right">建议价</th><th className="px-3 py-2 text-right">底价</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map((l) => (
                  <tr key={l.id} className={checked.has(l.id) ? 'bg-indigo-50' : ''}>
                    <td className="px-3 py-2"><input type="checkbox" checked={checked.has(l.id)} onChange={() => toggle(l.id)} /></td>
                    <td className="px-3 py-2">{l.material_name}</td>
                    <td className="px-3 py-2 text-gray-500">{l.specification || '—'}</td>
                    <td className="px-3 py-2 text-center">{l.ordered_qty} {l.ordered_unit}</td>
                    <td className="px-3 py-2 text-right">{l.price_baseline ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{l.unit_price ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <button onClick={submit} disabled={saving}
        className="w-full py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
        {saving ? '创建中…' : `创建采购单（已选 ${checked.size} 行）`}
      </button>
      {dialog}
    </div>
  );
}
