'use client';

import { useState, useEffect } from 'react';
import { getCrossOrderNetting } from '@/app/actions/procurement-netting';
import { createPurchaseOrder } from '@/app/actions/purchase-orders';
import { listSuppliers } from '@/app/actions/suppliers';
import type { NettingGroup } from '@/lib/services/netting';
import { useDialogs } from '@/components/ui/useDialogs';

/**
 * 待采购工作台 —— 未归单的待下单采购行,按 consolidation_key 自动分组(跨订单同料同色同规格)。
 * 两个动作(用户拍板双按钮):
 *   ①「合并需求行」:选中须同键(同料同色同规格)→ 并为一行下单(mergeSameMaterials)。异键→护栏警示。
 *   ②「归到一张采购单」:选中可跨料跨色(同供应商)→ 一张 PO,各料分行,仍 peg 各自订单。
 */
export function NettingClient() {
  const { confirm, dialog } = useDialogs();
  const [groups, setGroups] = useState<NettingGroup[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [supplierId, setSupplierId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setLoading(true);
    const [g, s] = await Promise.all([getCrossOrderNetting(), listSuppliers()]);
    setGroups(g.data || []);
    setSuppliers(s.data || []);
    setChecked(new Set());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function toggle(key: string) {
    setChecked((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    setMsg(null);
  }

  const checkedGroups = groups.filter((g) => checked.has(g.key));
  const checkedLineIds = checkedGroups.flatMap((g) => g.line_ids);
  const crossOrderCount = groups.filter((g) => g.order_count > 1).length;

  async function build(mode: 'merge' | 'group') {
    setMsg(null);
    const supplierName = suppliers.find((s) => s.id === supplierId)?.name || '';
    if (!supplierId) { setMsg({ ok: false, text: '请先选择供应商' }); return; }
    if (checkedGroups.length === 0) { setMsg({ ok: false, text: '请勾选要下单的物料' }); return; }

    // 护栏:① 合并需求行只允许同键(每组一个 key → 选中 >1 组即不同键)
    if (mode === 'merge' && checkedGroups.length > 1) {
      await confirm({
        title: '不能并成一行',
        message: `所选包含 ${checkedGroups.length} 种不同物料/颜色/规格,无法合并成一行需求。\n\n仅「同料同色同规格」可合并需求行。\n若只是想发给同一供应商,请改用「归到一张采购单」。`,
        confirmText: '知道了',
      });
      return;
    }

    const mergeSameMaterials = mode === 'merge';
    const ok = await confirm({
      title: mode === 'merge' ? '合并需求行并下单?' : '归到一张采购单?',
      message: mode === 'merge'
        ? `将「${checkedGroups[0].material_name}」（${checkedGroups[0].line_ids.length} 行 · 跨 ${checkedGroups[0].order_count} 单）并为一行,下给「${supplierName}」。`
        : `将 ${checkedGroups.length} 种物料（共 ${checkedLineIds.length} 行）归到一张采购单,下给「${supplierName}」。各料分行,仍 peg 各自订单。`,
      confirmText: '确认建单',
    });
    if (!ok) return;

    setSubmitting(true);
    const res = await createPurchaseOrder({ supplierId, lineItemIds: checkedLineIds, mergeSameMaterials });
    setSubmitting(false);
    if (res.error) { setMsg({ ok: false, text: res.error }); return; }
    setMsg({ ok: true, text: `✅ 已建采购单 ${res.poNo}` });
    setSupplierId('');
    load();
  }

  if (loading) return <p className="text-sm text-gray-400">加载中…</p>;
  if (groups.length === 0) {
    return <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">暂无未归单的待下单采购行</div>;
  }

  return (
    <div className="space-y-3 pb-28">
      {/* 顶部:供应商 + 主动提醒 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">下单供应商(两个动作共用)</label>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">— 选择供应商 —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <p className="text-xs text-gray-500 sm:pb-2">
          共 <b>{groups.length}</b> 组待归单{crossOrderCount > 0 && <> · <span className="text-indigo-600">{crossOrderCount} 组可跨订单合并</span></>}
        </p>
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</div>
      )}

      {/* 分组列表(勾选) */}
      {groups.map((g) => (
        <label key={g.key}
          className={`flex items-start gap-3 bg-white rounded-xl border p-4 cursor-pointer transition ${checked.has(g.key) ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-gray-200 hover:border-gray-300'}`}>
          <input type="checkbox" checked={checked.has(g.key)} onChange={() => toggle(g.key)} className="mt-1 accent-indigo-600" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900 truncate">{g.material_name}</h3>
              {g.color && <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">色:{g.color}</span>}
              {g.order_count > 1 && <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">跨 {g.order_count} 单</span>}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {g.specification || '—'} · 共 <b>{g.total_qty}</b> {g.unit || ''} · {g.line_ids.length} 行
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {g.contributors.map((c) => (
                <span key={c.line_id} className="text-[11px] px-2 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-600">{c.order_ref}: {c.qty}</span>
              ))}
            </div>
          </div>
        </label>
      ))}

      {/* 底部动作条:双按钮 */}
      <div className="fixed bottom-0 left-0 right-0 sm:left-56 bg-white/95 backdrop-blur border-t border-gray-200 px-4 py-3 z-40">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="text-xs text-gray-500 flex-1">已选 <b>{checkedGroups.length}</b> 组 · {checkedLineIds.length} 行</span>
          <button onClick={() => build('merge')} disabled={submitting || checkedGroups.length === 0}
            className="text-sm px-4 py-2 rounded-lg border border-indigo-300 text-indigo-700 bg-white hover:bg-indigo-50 font-medium disabled:opacity-40"
            title="仅同料同色同规格可合并成一行下单">
            合并需求行
          </button>
          <button onClick={() => build('group')} disabled={submitting || checkedGroups.length === 0}
            className="text-sm px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-40"
            title="不同料/色也可,发给同一供应商一张单,各料分行">
            {submitting ? '建单中…' : '归到一张采购单'}
          </button>
        </div>
      </div>

      {dialog}
    </div>
  );
}
