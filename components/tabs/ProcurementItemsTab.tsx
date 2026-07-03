'use client';
import { useEffect, useState } from 'react';
import {
  listProcurementItems, consolidateOrderProcurementItems, getProcurementItemSources,
  updateProcurementItem, updateProcurementItemStatus, updateProcurementItemImages,
  generateExecutionLines, getOrderProcurementFulfillment,
} from '@/app/actions/procurement-items';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { requestSupplementQty, approveSupplement } from '@/app/actions/procurement-supplement';
import { listSuppliers } from '@/app/actions/suppliers';
import { recordLeftoverStocktake, getAvailableStockByKeys } from '@/app/actions/inventory';
import { computeSuggestedPurchaseQty } from '@/lib/services/procurement-consolidation';

/** 补采购财务审批状态 → 显示 */
const SUPP_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待财务审批', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: '财务已批准', cls: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: '财务已驳回', cls: 'bg-red-100 text-red-700' },
};

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
const fmtD = (iso: any) => iso ? `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()}` : '';

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
  const [fulfillment, setFulfillment] = useState<any[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());   // ② 批量确认勾选
  // 供应商主数据(确认供应商下拉用;不再手敲名字)
  const [supplierOptions, setSupplierOptions] = useState<any[]>([]);
  useEffect(() => {
    listSuppliers().then(r => { if ((r as any).data) setSupplierOptions((r as any).data); });
  }, []);
  // 尾料归库 + 库存抵扣
  const [avail, setAvail] = useState<Record<string, { available: number; location: string | null }>>({});
  const [stocktakeOpen, setStocktakeOpen] = useState(false);
  const [stForm, setStForm] = useState<Record<string, { counted: string; location: string }>>({});
  const [stBusy, setStBusy] = useState(false);

  const reload = async () => {
    const res = await listProcurementItems(orderId);
    const list = (res as any).error ? [] : ((res as any).data || []);
    if ((res as any).error) setMsg((res as any).error); else setItems(list);
    const ff = await getOrderProcurementFulfillment(orderId);
    if ((ff as any).data) setFulfillment((ff as any).data);
    // 各采购项的库存可用量(按 consolidation_key)
    const keys = list.map((i: any) => i.consolidation_key).filter(Boolean);
    if (keys.length) {
      const av = await getAvailableStockByKeys(keys);
      if ((av as any).data) setAvail((av as any).data);
    }
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);

  const confirmedCount = items.filter(i => i.status === 'confirmed').length;
  async function genLines() {
    setBusy(true); setMsg('');
    const res = await generateExecutionLines(orderId);
    setBusy(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg((res as any).created > 0 ? `✅ 已生成 ${(res as any).created} 条采购执行行(去采购中心下单)` : ((res as any).message || '无新执行行'));
    await reload();
  }

  // ── 两步归并(2026-07-03 用户拍板:不许一键直写,先看变更计划再勾选执行)──
  const [mergePlan, setMergePlan] = useState<any | null>(null);
  const [applyOpts, setApplyOpts] = useState({ create: true, refresh: true, cleanup: true });

  async function consolidate() {
    setBusy(true); setMsg('');
    const res = await consolidateOrderProcurementItems(orderId, { dryRun: true });
    setBusy(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    const p = (res as any).plan;
    const hasChanges = p && (p.creates.length > 0 || p.qtyUpdates.length > 0 || p.orphanDelete.length > 0 || p.orphanFlag.length > 0);
    if (!hasChanges) {
      // 只有参数/图片/日期同步(不改数量不删项)= 安全,直接执行
      if (p?.paramRefresh > 0) {
        setBusy(true);
        const r2 = await consolidateOrderProcurementItems(orderId, { apply: { create: false, refresh: true, cleanup: false } });
        setBusy(false);
        if ((r2 as any).error) { setMsg((r2 as any).error); return; }
        setMsg(`✅ 与需求一致,已同步参数/图片/日期 ${(r2 as any).updated} 项(数量无变化)`);
        await reload();
      } else {
        setMsg('✅ 与需求一致,无需变更');
      }
      return;
    }
    setApplyOpts({ create: true, refresh: true, cleanup: true });
    setMergePlan(p);                                   // 弹出变更计划,人勾选后执行
  }

  async function executeMerge() {
    setBusy(true); setMsg('');
    const res = await consolidateOrderProcurementItems(orderId, { apply: applyOpts });
    setBusy(false); setMergePlan(null);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(`✅ 归并完成:新增 ${(res as any).created} / 刷新 ${(res as any).updated}${(res as any).flagged ? ` / 标记需重确认 ${(res as any).flagged}` : ''}${(res as any).removed ? ` / 清理孤儿 ${(res as any).removed}` : ''}`);
    await reload();
  }

  // 尾料清点归库:用 fulfillment(received>0)的行,默认清点数=当前尾货
  const stocktakeRows = fulfillment.filter(f => f.received > 0);
  function openStocktake() {
    const init: Record<string, { counted: string; location: string }> = {};
    for (const f of stocktakeRows) init[f.consolidation_key] = { counted: String(f.leftover ?? 0), location: '' };
    setStForm(init); setStocktakeOpen(true);
  }
  async function submitStocktake() {
    const payload = stocktakeRows.map(f => ({
      materialKey: f.consolidation_key, materialName: f.material_name, unit: f.unit,
      countedQty: Number(stForm[f.consolidation_key]?.counted ?? 0) || 0,
      location: stForm[f.consolidation_key]?.location || null,
    }));
    setStBusy(true);
    const res = await recordLeftoverStocktake(orderId, payload);
    setStBusy(false);
    if ((res as any).error) { setMsg('❌ ' + (res as any).error); return; }
    setMsg(`✅ 尾料归库完成(${(res as any).adjusted} 项入账),余料已进库存,下次采购同料可抵扣`);
    setStocktakeOpen(false); await reload();
  }

  // 用库存抵扣:把某采购项的最终采购量减去可用库存
  function deductStock(item: any) {
    const a = avail[item.consolidation_key];
    if (!a || a.available <= 0) return;
    const base = Number(form.final_purchase_qty) || Number(item.final_purchase_qty) || Number(item.suggested_purchase_qty) || 0;
    const next = Math.max(0, Math.round((base - a.available) * 1000) / 1000);
    setForm(f => ({ ...f, final_purchase_qty: String(next) }));
  }

  async function select(item: any) {
    if (selId === item.id) { setSelId(null); return; }
    setSelId(item.id); setSources([]);
    const f: Record<string, any> = {};
    for (const k of FORM_KEYS) f[k] = item[k] ?? '';
    // 采购计量单位默认=该项单位(物料录入时就选过,不让采购重敲;按匹/按卷等买法不同才改)
    if (!f.purchase_unit) f.purchase_unit = item.unit || '';
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
    // 日常连续核料:确认完自动展开下一项待核(2026-07-03 用户拍板加强确认流)
    if (status === 'confirmed') {
      const next = items.find(i => i.id !== selId && ['draft', 'reviewing'].includes(i.status));
      if (next) { await select(next); setMsg(`✅ 已确认,自动跳到下一项:${next.material_name || ''}${next.color ? ' · ' + next.color : ''}`); }
      else { setSelId(null); setMsg('✅ 已确认 — 该单核料全部处理完,可「生成执行行」'); }
    }
  }

  // ── 色卡/辅料图(业务执行+采购都可传/删;上传进公开桶 product-images,与 BOM 同桶) ──
  const [imgBusy, setImgBusy] = useState(false);
  async function uploadItemImage(file: File) {
    if (!sel) return;
    setImgBusy(true); setMsg('');
    try {
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `procurement/${orderId}/${sel.id}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (error) { setMsg('上传失败:' + error.message); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      const next = [...(Array.isArray(sel.image_urls) ? sel.image_urls : []), data.publicUrl].slice(0, 8);
      const res = await updateProcurementItemImages(sel.id, orderId, next);
      if ((res as any).error) { setMsg((res as any).error); return; }
      await reload();
    } finally { setImgBusy(false); }
  }
  async function removeItemImage(url: string) {
    if (!sel || !window.confirm('移除这张图?(不删除原文件,只从此项摘掉)')) return;
    const next = (Array.isArray(sel.image_urls) ? sel.image_urls : []).filter((u: string) => u !== url);
    const res = await updateProcurementItemImages(sel.id, orderId, next);
    if ((res as any).error) { setMsg((res as any).error); return; }
    await reload();
  }

  // 数量补:对已有项申请补量(业务执行提交;服务端角色把关)
  async function requestSupp(item: any) {
    const qtyStr = window.prompt(`补采购「${item.material_name || ''}」\n\n补多少(单位:${item.unit || '同原项'})?只填数字:`, '');
    if (qtyStr === null) return;
    const qty = Number(qtyStr);
    if (!qty || qty <= 0 || isNaN(qty)) { setMsg('补量必须是大于 0 的数字'); return; }
    const reason = window.prompt('补采购原因(财务审批要看,必填):\n如「生产损耗超标」「裁剪数量不够」', '');
    if (reason === null) return;
    const res = await requestSupplementQty(orderId, item.id, qty, reason || '');
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(`✅ 补料申请已提交(${(res as any).itemNo}),已通知财务审批`);
    await reload();
  }

  // 财务审批补采购(服务端仅财务/管理员可批)
  async function approveSupp(item: any, ok: boolean) {
    let rejectReason: string | undefined;
    if (!ok) {
      const r = window.prompt('驳回原因(必填):', '');
      if (r === null) return;
      rejectReason = r;
    } else if (!window.confirm(`批准补采购「${item.material_name}」${item.total_required_qty}${item.unit || ''}?\n批准后采购部即可确认并执行。`)) {
      return;
    }
    const res = await approveSupplement(item.id, ok, rejectReason);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(ok ? '✅ 已批准,采购部可执行' : '已驳回');
    await reload();
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  const sel = items.find(i => i.id === selId);

  // ── 确认归并加强(2026-07-03 用户拍板 1-4)──
  const DONE_STATUSES = ['confirmed', 'ordered', 'partially_received', 'completed', 'closed'];
  const pendingItems = items.filter(i => ['draft', 'reviewing'].includes(i.status));
  const doneCount = items.length - pendingItems.length;
  // ② 批量确认资格:供应商+数量齐、无风险/替代标记、非待批补采购(这些强制逐项人核)
  const canBulkConfirm = (i: any) =>
    ['draft', 'reviewing'].includes(i.status)
    && String(i.confirmed_supplier_name || '').trim()
    && (i.final_purchase_qty ?? i.suggested_purchase_qty) != null
    && !i.risk_flag && !i.is_substitute && !i.needs_reconfirm
    && !(i.is_supplement && i.finance_approval_status !== 'approved');
  const bulkEligible = items.filter(canBulkConfirm);
  const checkedEligible = bulkEligible.filter(i => checked.has(i.id));
  // ④ 下单倒计时:超最晚下单日=🔥,3天内=⏰
  const deadlineBadge = (i: any) => {
    if (!i.order_by_date || DONE_STATUSES.includes(i.status)) return null;
    const days = Math.floor((new Date(i.order_by_date + 'T23:59:59+08:00').getTime() - Date.now()) / 86400000);
    if (days < 0) return { cls: 'bg-red-100 text-red-700', text: `🔥 超最晚下单日${-days}天`, tip: `需到 ${i.required_date || '?'} · 最晚下单 ${i.order_by_date},今天不下单赶不上生产` };
    if (days <= 3) return { cls: 'bg-amber-100 text-amber-700', text: `⏰ ${days === 0 ? '今天' : days + '天内'}须下单`, tip: `需到 ${i.required_date || '?'} · 最晚下单 ${i.order_by_date}` };
    return null;
  };

  async function bulkConfirm() {
    const ids = checkedEligible.map(i => i.id);
    if (ids.length === 0) return;
    if (!window.confirm(`批量确认 ${ids.length} 项采购?(有风险/替代/待批补采购的项不在其列,需逐项处理)`)) return;
    setBusy(true); setMsg('');
    let ok = 0; const fails: string[] = [];
    for (const id of ids) {
      const r = await updateProcurementItemStatus(id, orderId, 'confirmed');
      if ((r as any).error) fails.push((r as any).error); else ok++;
    }
    setBusy(false); setChecked(new Set());
    setMsg(`✅ 批量确认 ${ok}/${ids.length} 项${fails.length ? `;首个失败原因:${fails[0]}` : ''}`);
    await reload();
  }
  // 实时建议采购(2026-07-03 用户拍板:改任何数立即看到结果)——
  // 与服务端保存时用的是同一个内核纯函数,单一算法口径(ADR-005),不会出现两套数
  const liveSuggested = sel ? computeSuggestedPurchaseQty({
    total_required_qty: sel.total_required_qty,
    development_consumption: sel.development_consumption,
    production_consumption: form.production_consumption,
    procurement_loss_pct: form.procurement_loss_pct,
    safety_stock_qty: form.safety_stock_qty,
    moq: form.moq,
  }) : null;

  return (
    <div className="space-y-4">
      {/* 归并变更计划弹窗(先看后勾选,人确认才执行) */}
      {mergePlan && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setMergePlan(null)}>
          <div className="bg-white rounded-xl max-w-2xl w-full my-8 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-800">🔄 归并变更计划 — 勾选要执行的,确认才落库</span>
              <button onClick={() => setMergePlan(null)} className="text-xs text-gray-400 hover:text-gray-600">取消</button>
            </div>
            <div className="p-4 space-y-3 text-xs max-h-[60vh] overflow-y-auto">
              {mergePlan.creates.length > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
                  <label className="flex items-center gap-2 font-semibold text-emerald-800 cursor-pointer">
                    <input type="checkbox" checked={applyOpts.create} onChange={e => setApplyOpts(o => ({ ...o, create: e.target.checked }))} className="accent-emerald-600" />
                    ➕ 新增 {mergePlan.creates.length} 项
                  </label>
                  <ul className="mt-1.5 space-y-0.5 text-emerald-700">
                    {mergePlan.creates.map((c: any, i: number) => (
                      <li key={i}>· {c.material_name}{c.color ? ` · ${c.color}` : ''} — {c.qty}{c.unit || ''}{c.is_supplement ? ' 🟠(采购下单后新增=补采购,需财务审批)' : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
              {mergePlan.qtyUpdates.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                  <label className="flex items-center gap-2 font-semibold text-amber-800 cursor-pointer">
                    <input type="checkbox" checked={applyOpts.refresh} onChange={e => setApplyOpts(o => ({ ...o, refresh: e.target.checked }))} className="accent-amber-600" />
                    ✏️ 总需求变化 {mergePlan.qtyUpdates.length} 项(旧→新)
                  </label>
                  <ul className="mt-1.5 space-y-0.5 text-amber-700">
                    {mergePlan.qtyUpdates.map((u: any, i: number) => (
                      <li key={i}>· {u.item_no} {u.material_name}{u.color ? ` · ${u.color}` : ''}:{u.oldQty} → <b>{u.newQty}</b>{u.unit || ''}{u.willFlag ? '(已确认项,将标⚠需重确认)' : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(mergePlan.orphanDelete.length > 0 || mergePlan.orphanFlag.length > 0) && (
                <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
                  <label className="flex items-center gap-2 font-semibold text-red-800 cursor-pointer">
                    <input type="checkbox" checked={applyOpts.cleanup} onChange={e => setApplyOpts(o => ({ ...o, cleanup: e.target.checked }))} className="accent-red-600" />
                    🗑 来源已消失的孤儿项 {mergePlan.orphanDelete.length + mergePlan.orphanFlag.length} 项
                  </label>
                  <ul className="mt-1.5 space-y-0.5 text-red-700">
                    {mergePlan.orphanDelete.map((o: any, i: number) => (
                      <li key={`d${i}`}>· {o.item_no} {o.material_name}{o.color ? ` · ${o.color}` : ''} — 草稿,将<b>删除</b></li>
                    ))}
                    {mergePlan.orphanFlag.map((o: any, i: number) => (
                      <li key={`f${i}`}>· {o.item_no} {o.material_name}{o.color ? ` · ${o.color}` : ''} — {statusLabel(o.status)},保留并标⚠(已进采购流程,人来决策)</li>
                    ))}
                  </ul>
                </div>
              )}
              {mergePlan.paramRefresh > 0 && (
                <p className="text-gray-400">另有 {mergePlan.paramRefresh} 项数量无变化,仅同步参数/图片/日期(随「刷新」勾选一并执行)</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-gray-200 flex gap-2 justify-end">
              <button onClick={() => setMergePlan(null)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消(什么都不动)</button>
              <button onClick={executeMerge} disabled={busy || (!applyOpts.create && !applyOpts.refresh && !applyOpts.cleanup)}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
                {busy ? '执行中…' : '✅ 执行勾选的变更'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 尾料清点归库弹窗 */}
      {stocktakeOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setStocktakeOpen(false)}>
          <div className="bg-white rounded-xl max-w-2xl w-full my-8 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-800">📦 尾料清点归库(出货后)</span>
              <button onClick={() => setStocktakeOpen(false)} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
            </div>
            <div className="p-4">
              <p className="text-xs text-gray-500 mb-3">清点每个物料实际剩多少,填实际尾料数 + 库位。系统把账面盘到实际数,余料进共享库存,下次采购同料自动抵扣。默认值=当前账面尾货,按实物改。</p>
              <div className="overflow-x-auto border border-gray-100 rounded-lg">
                <table className="w-full text-xs">
                  <thead><tr className="bg-gray-50 text-left text-gray-500">
                    {['物料', '单位', '当前账面尾货', '实际尾料 *', '库位'].map(h => <th key={h} className="px-2 py-1.5 font-medium whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {stocktakeRows.map(f => (
                      <tr key={f.consolidation_key} className="border-t border-gray-50">
                        <td className="px-2 py-1.5 text-gray-800">{f.material_name || '—'}</td>
                        <td className="px-2 py-1.5 text-gray-400">{f.unit || '—'}</td>
                        <td className={`px-2 py-1.5 font-mono ${f.leftover < 0 ? 'text-red-600' : 'text-amber-600'}`}>{f.leftover}</td>
                        <td className="px-2 py-1.5">
                          <input type="number" min="0" value={stForm[f.consolidation_key]?.counted ?? ''}
                            onChange={e => setStForm(s => ({ ...s, [f.consolidation_key]: { ...s[f.consolidation_key], counted: e.target.value } }))}
                            className="w-24 rounded border border-gray-300 px-2 py-1 text-right" />
                        </td>
                        <td className="px-2 py-1.5">
                          <input value={stForm[f.consolidation_key]?.location ?? ''} placeholder="如 A-03"
                            onChange={e => setStForm(s => ({ ...s, [f.consolidation_key]: { ...s[f.consolidation_key], location: e.target.value } }))}
                            className="w-28 rounded border border-gray-300 px-2 py-1" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={submitStocktake} disabled={stBusy}
                  className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
                  {stBusy ? '归库中…' : '✅ 确认归库'}</button>
                <button onClick={() => setStocktakeOpen(false)}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 顶部 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-500">{items.length} 个采购核料项 · 同订单按 物料+颜色+单位 自动归并</div>
        <div className="flex items-center gap-2">
          {confirmedCount > 0 && (
            <button onClick={genLines} disabled={busy}
              className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
              title="把已确认采购项生成采购执行行(下单/收货用)">
              {busy ? '生成中…' : `➡️ 生成执行行（${confirmedCount} 已确认）`}</button>
          )}
          <button onClick={consolidate} disabled={busy}
            className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy ? '核料中…' : '🔄 核料归并 / 刷新'}</button>
        </div>
      </div>
      {msg && <p className="text-xs text-gray-600">{msg}</p>}

      {/* ③ 核料完成度 + ② 批量确认 工具条 */}
      {items.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-gray-800">核料进度 {doneCount}/{items.length}</span>
            <div className="flex-1 min-w-[140px] h-2 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${items.length ? Math.round(doneCount / items.length * 100) : 0}%` }} />
            </div>
            {bulkEligible.length > 0 && (
              <>
                <button onClick={() => setChecked(checked.size === bulkEligible.length ? new Set() : new Set(bulkEligible.map(i => i.id)))}
                  className="text-xs text-indigo-600 hover:underline">
                  {checked.size === bulkEligible.length ? '取消全选' : `全选可批量确认(${bulkEligible.length})`}
                </button>
                <button onClick={bulkConfirm} disabled={busy || checkedEligible.length === 0}
                  className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">
                  ✅ 批量确认({checkedEligible.length})
                </button>
              </>
            )}
          </div>
          {pendingItems.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-gray-400">待核:</span>
              {pendingItems.map(i => (
                <button key={i.id} onClick={() => select(i)}
                  className={`px-2 py-0.5 rounded-full border ${selId === i.id ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  {i.material_name || i.item_no}{i.color ? ` · ${i.color}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
              {['☑', '编号', '物料', '类别', '颜色', '单位', '总需求', '库存可用', '来源', '建议采购', '最终', '供应商', '状态', ''].map(h => (
                <th key={h} className="py-2 px-2 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className={`border-b border-gray-50 hover:bg-gray-50 cursor-pointer ${selId === it.id ? 'bg-indigo-50/40' : ''}`} onClick={() => select(it)}>
                  <td className="py-2 px-2" onClick={e => e.stopPropagation()}>
                    {canBulkConfirm(it) ? (
                      <input type="checkbox" checked={checked.has(it.id)}
                        onChange={e => setChecked(prev => { const n = new Set(prev); e.target.checked ? n.add(it.id) : n.delete(it.id); return n; })}
                        className="w-3.5 h-3.5 accent-emerald-600" title="可批量确认" />
                    ) : <span className="text-gray-200">·</span>}
                  </td>
                  <td className="py-2 px-2 font-mono text-xs text-indigo-600 whitespace-nowrap">
                    {it.needs_reconfirm && <span title="需重新确认" className="text-amber-600">⚠ </span>}
                    {it.is_supplement && <span title={`补采购:${it.supplement_reason || ''}`} className={`mr-1 px-1.5 py-px rounded text-[10px] font-medium ${SUPP_STATUS[it.finance_approval_status]?.cls || 'bg-amber-100 text-amber-700'}`}>🟠补</span>}
                    {(() => { const b = deadlineBadge(it); return b ? <span title={b.tip} className={`mr-1 px-1.5 py-px rounded text-[10px] font-medium ${b.cls}`}>{b.text}</span> : null; })()}
                    {it.item_no || '—'}</td>
                  <td className="py-2 px-2 font-medium text-gray-900">
                    <span className="inline-flex items-center gap-1.5">
                      {Array.isArray(it.image_urls) && it.image_urls[0] && (
                        <img src={it.image_urls[0]} alt="" className="w-7 h-7 rounded object-cover border border-gray-200 shrink-0" />
                      )}
                      {it.material_name || '—'}
                    </span>
                  </td>
                  <td className="py-2 px-2"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{CAT_LABEL[it.category] || it.category || '—'}</span></td>
                  <td className="py-2 px-2 text-gray-600">{it.color || '—'}</td>
                  <td className="py-2 px-2 text-gray-600">{it.unit || '—'}</td>
                  <td className="py-2 px-2 text-gray-700">{it.total_required_qty ?? '—'}</td>
                  <td className="py-2 px-2">
                    {avail[it.consolidation_key]?.available > 0
                      ? <span title={avail[it.consolidation_key].location ? `库位 ${avail[it.consolidation_key].location}` : ''} className="text-emerald-700 font-medium">{avail[it.consolidation_key].available}{avail[it.consolidation_key].location ? ` @${avail[it.consolidation_key].location}` : ''}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
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

      {/* 执行 / 核销进度(B3a:需求→下单→收货→消耗→尾货)*/}
      {fulfillment.some(f => f.ordered > 0 || f.received > 0 || f.consumed > 0) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-semibold text-gray-800">执行 / 核销进度</div>
            {stocktakeRows.length > 0 && (
              <button onClick={openStocktake} className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700">
                📦 尾料清点归库
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mb-3">下单/收货来自采购执行行 · 消耗/尾货来自库存领料流水(按物料身份核销)· 出货后点「尾料清点归库」把实物余料入库,下次采购同料自动抵扣</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500 border-b border-gray-100">
                {['物料', '状态', '需求', '下单', '收货', '消耗(领料)', '尾货', '单位'].map(h => (
                  <th key={h} className="py-1.5 px-2 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {fulfillment.filter(f => f.ordered > 0 || f.received > 0 || f.consumed > 0).map(f => (
                  <tr key={f.procurement_item_id} className="border-b border-gray-50">
                    <td className="py-1.5 px-2 text-gray-800">{f.material_name || '—'}</td>
                    <td className="py-1.5 px-2"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{statusLabel(f.status)}</span></td>
                    <td className="py-1.5 px-2 text-gray-500 font-mono">{f.required}</td>
                    <td className="py-1.5 px-2 text-gray-700 font-mono">{f.ordered}</td>
                    <td className="py-1.5 px-2 text-gray-700 font-mono">{f.received}</td>
                    <td className="py-1.5 px-2 text-indigo-700 font-mono">{f.consumed}</td>
                    <td className={`py-1.5 px-2 font-mono font-semibold ${f.leftover < 0 ? 'text-red-600' : f.leftover > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{f.leftover}</td>
                    <td className="py-1.5 px-2 text-gray-400">{f.unit || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 展开:来源明细 + 采购确认 */}
      {sel && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-semibold text-gray-800">
              {sel.item_no} · {sel.material_name} {sel.color ? `· ${sel.color}` : ''}
              <span className="ml-2 font-normal text-[11px] text-gray-400">
                {sel.created_by_name ? `录入:${sel.created_by_name} ${fmtD(sel.created_at)}` : ''}
                {sel.confirmed_by_name ? ` · 确认:${sel.confirmed_by_name} ${fmtD(sel.confirmed_at)}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!sel.is_supplement && (
                <button onClick={() => requestSupp(sel)}
                  title="生产中数量不够(损耗超标/裁剪不足)→ 业务执行提补量申请,财务批准后采购执行"
                  className="text-xs px-2.5 py-1 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700">➕ 补数量申请</button>
              )}
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">{statusLabel(sel.status)}</span>
            </div>
          </div>

          {/* 补采购信息 + 财务审批(服务端按角色把关:仅财务/管理员可批) */}
          {sel.is_supplement && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-amber-800">🟠 补采购</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${SUPP_STATUS[sel.finance_approval_status]?.cls || ''}`}>
                  {SUPP_STATUS[sel.finance_approval_status]?.label || sel.finance_approval_status}
                </span>
                {sel.finance_approval_status === 'pending' && <>
                  <button onClick={() => approveSupp(sel, true)}
                    className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">✅ 批准(财务)</button>
                  <button onClick={() => approveSupp(sel, false)}
                    className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700">✖ 驳回(财务)</button>
                </>}
              </div>
              <p className="text-amber-700">
                原因:{sel.supplement_reason || '—'}
                {sel.supplement_requested_by_name && <span className="text-amber-500"> · 申请人:{sel.supplement_requested_by_name} {fmtD(sel.supplement_requested_at)}</span>}
                {sel.finance_approved_by_name && <span className="text-amber-500"> · 审批:{sel.finance_approved_by_name} {fmtD(sel.finance_approved_at)}</span>}
              </p>
              {sel.finance_approval_status === 'rejected' && sel.finance_reject_reason && (
                <p className="text-red-600">驳回原因:{sel.finance_reject_reason}</p>
              )}
              {sel.finance_approval_status === 'pending' && (
                <p className="text-amber-600">批准后采购部才能「确认→生成执行行→归采购单」;此项会同步进财务系统预警。</p>
              )}
            </div>
          )}

          {/* 色卡/辅料图(业务上传随归并流转;业务执行+采购都可补拍/移除) */}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500">🎨 色卡 / 辅料参考图({(sel.image_urls || []).length})<span className="font-normal text-gray-400"> · 业务「原辅料」传的图自动带过来;双方都可补</span></span>
              <label className={`text-xs px-2.5 py-1 rounded-lg cursor-pointer font-medium ${imgBusy ? 'bg-gray-100 text-gray-400' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
                {imgBusy ? '上传中…' : '📷 上传图片'}
                <input type="file" accept="image/*" className="hidden" disabled={imgBusy}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadItemImage(f); }} />
              </label>
            </div>
            {(sel.image_urls || []).length === 0 ? (
              <p className="text-xs text-gray-400">暂无图片 — 业务在「原辅料」上传色卡后点「核料归并/刷新」会自动带入;或直接点上方上传</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(sel.image_urls as string[]).map((u, i) => (
                  <span key={i} className="relative group">
                    <a href={u} target="_blank" rel="noreferrer">
                      <img src={u} alt={`图${i + 1}`} className="w-16 h-16 rounded-lg object-cover border border-gray-200 hover:scale-[2.2] hover:z-10 transition-transform origin-top-left" />
                    </a>
                    <button onClick={() => removeItemImage(u)} title="移除"
                      className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-4 h-4 items-center justify-center rounded-full bg-red-500 text-white text-[10px]">×</button>
                  </span>
                ))}
              </div>
            )}
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
            <div>
              <span className="text-gray-500">建议采购(实时算)</span>
              <div className="mt-1 w-full rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 font-semibold text-emerald-800"
                title="= 总需求 × (大货单耗÷开发单耗) × (1+采购损耗%) + 安全库存,按 MOQ 向上取整。改左边任何数,这里立即重算。">
                {liveSuggested ?? '—'}
                {liveSuggested != null && sel.suggested_purchase_qty != null && liveSuggested !== Number(sel.suggested_purchase_qty) && (
                  <span className="ml-1 text-[10px] font-normal text-emerald-600">(保存前:{sel.suggested_purchase_qty})</span>
                )}
              </div>
            </div>
            <label className="block">
              <span className="text-gray-500">最终采购量(人拍板)</span>
              <div className="flex gap-1 mt-1">
                <input type="number" step="any" value={form.final_purchase_qty ?? ''}
                  placeholder={liveSuggested != null ? `留空=按建议 ${liveSuggested}` : ''}
                  onChange={e => set('final_purchase_qty', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5" />
                {liveSuggested != null && (
                  <button onClick={() => set('final_purchase_qty', String(liveSuggested))}
                    title="把系统建议填入最终采购量"
                    className="shrink-0 text-[10px] px-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50">按建议</button>
                )}
              </div>
              <span className="text-[10px] text-gray-400">留空 = 下单时自动按建议采购量;要整匹/凑量就自己填,你说了算</span>
            </label>
          </div>

          {/* 库存抵扣:该物料有可用尾料 → 一键从最终采购量扣减 */}
          {avail[sel.consolidation_key]?.available > 0 && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-xs flex items-center justify-between gap-2">
              <span className="text-emerald-800">
                📦 库存有 <b>{avail[sel.consolidation_key].available}</b> {sel.unit || ''} 可用
                {avail[sel.consolidation_key].location && <>(库位 {avail[sel.consolidation_key].location})</>}
                ,可抵扣本次采购
              </span>
              <button onClick={() => deductStock(sel)}
                className="shrink-0 px-3 py-1 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">用库存抵扣</button>
            </div>
          )}

          {/* 供应商(从供应商主数据选,不再手敲;选中自动带联系人) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <label className="block">
              <span className="text-gray-500">确认供应商</span>
              <select value={form.confirmed_supplier_name ?? ''}
                onChange={e => {
                  const name = e.target.value;
                  set('confirmed_supplier_name', name);
                  const sup = supplierOptions.find(s => s.name === name);
                  if (sup?.contact_name && !form.supplier_contact) set('supplier_contact', sup.contact_name);
                }}
                className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 bg-white">
                <option value="">— 选择供应商 —</option>
                {/* 旧数据手敲的名字不在主数据里 → 保留为一个选项,不丢 */}
                {form.confirmed_supplier_name && !supplierOptions.some(s => s.name === form.confirmed_supplier_name) && (
                  <option value={form.confirmed_supplier_name}>{form.confirmed_supplier_name}(手工历史)</option>
                )}
                {supplierOptions.map(s => <option key={s.id} value={s.name}>{s.name}{s.main_category ? `(${s.main_category})` : ''}</option>)}
              </select>
              <a href="/suppliers" target="_blank" className="text-[10px] text-indigo-500 hover:underline">没有?去建供应商 →</a>
              {/* ① 供应商记忆:同物料上次从谁家买的、什么价 */}
              {sel.last_purchase && (
                <span className="block text-[10px] text-emerald-700 mt-0.5">
                  上次:{sel.last_purchase.supplier}
                  {sel.last_purchase.unit_price != null ? ` ¥${sel.last_purchase.unit_price}` : ''}
                  {sel.last_purchase.order_no ? `(${sel.last_purchase.order_no}` : '('}
                  {sel.last_purchase.confirmed_at ? ` ${fmtD(sel.last_purchase.confirmed_at)})` : ')'}
                  <button onClick={() => {
                    set('confirmed_supplier_name', sel.last_purchase.supplier);
                    if (sel.last_purchase.unit_price != null && !form.unit_price) set('unit_price', String(sel.last_purchase.unit_price));
                    if (sel.last_purchase.currency && !form.currency) set('currency', sel.last_purchase.currency);
                  }} className="ml-1 px-1.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">采纳</button>
                </span>
              )}
            </label>
            <Field label="联系人" k="supplier_contact" form={form} set={set} />
            <Field label="Lead(天)" k="lead_days" form={form} set={set} type="number" />
            <Field label="采购计量单位(米/kg/匹)" k="purchase_unit" form={form} set={set} />
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
                title="拿不准的项(替代料/价格异常/有风险)转采购经理复核;经理会收到系统通知,由他复核后点「确认采购」"
                className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">转采购经理复核</button>
            )}
            {sel.status === 'reviewing' && <span className="text-xs text-blue-600">⏳ 待采购经理复核(经理已收到通知)</span>}
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
