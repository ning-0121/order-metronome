'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SearchableSelect } from '@/components/SearchableSelect';
import {
  listProcurementItems, consolidateOrderProcurementItems, getProcurementItemSources,
  updateProcurementItem, updateProcurementItemStatus, updateProcurementItemImages, updateProcurementItemAttachments,
  generateExecutionLines, getOrderProcurementFulfillment,
  listBomConsumptionLines, saveBomOverPurchasePct, deductFromStock, deleteProcurementItemRow,
  saveBomBudgetUnitPrice, saveBomCustomerSupplied, getOrderStyleBudgets, saveOrderStyleBudgets, saveSizeQtyOverride, saveSkuBreakdown, mergeSplitExecutionLines,
} from '@/app/actions/procurement-items';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { requestSupplementQty, approveSupplement, approveBaselineOver } from '@/app/actions/procurement-supplement';
import { getOrderPurchaseOrders } from '@/app/actions/purchase-orders';
import { getAccessoryCostSummary } from '@/app/actions/procurement-cost';
import { listSuppliers } from '@/app/actions/suppliers';
import { recordLeftoverStocktake, getAvailableStockByKeys } from '@/app/actions/inventory';
import { computeSuggestedPurchaseQty } from '@/lib/services/procurement-consolidation';
import { useDialogs } from '@/components/ui/useDialogs';

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
// 服务端 sku 单元格 → 可编辑列表(qty 转字符串给 input)
const toSkuList = (cells: any[]) => (cells || []).map((c: any) => ({
  style_no: c.style_no || '', product_name: c.product_name || '',
  color_cn: c.color_cn || '', color_en: c.color_en || '', size: c.size || '', qty: String(c.qty ?? ''),
}));

const FORM_KEYS = [
  'production_consumption', 'procurement_loss_pct', 'safety_stock_qty', 'moq', 'purchase_unit', 'final_purchase_qty',
  'confirmed_supplier_name', 'backup_supplier_name', 'supplier_contact', 'lead_days', 'required_date',
  'unit_price', 'currency', 'tax_rate', 'price_inclusive_tax', 'quote_date',
  'is_substitute', 'substitute_reason', 'is_split', 'is_outsourced', 'risk_flag', 'risk_note', 'procurement_notes',
  'purchase_spec',
];

export function ProcurementItemsTab({ orderId, focusItemId, internalOrderNo }: { orderId: string; focusItemId?: string | null; internalOrderNo?: string | null }) {
  const { confirm, prompt, dialog } = useDialogs();
  const [items, setItems] = useState<any[]>([]);
  // 聚焦单料(采购中心点某行「任务单」带 ?item= 进来):只显示这一款料 + 顶部横幅可切回全部
  const [focus, setFocus] = useState<string | null>(focusItemId ?? null);
  const autoSelected = useRef(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [sizeBreakdown, setSizeBreakdown] = useState<Array<{ size: string | null; qty: number }>>([]);   // #3 尺码拆分预览
  const [sizeEdit, setSizeEdit] = useState<Record<string, string>>({});   // 尺码拆分可编辑(码→量)
  const [sizeOverrideActive, setSizeOverrideActive] = useState(false);    // 是否已存人工覆盖
  const [suggestedSplit, setSuggestedSplit] = useState<Array<{ size: string | null; qty: number }>>([]);  // 系统按比例建议(点「按尺码录入」时预填)
  const [splittable, setSplittable] = useState(true);   // 该料能否按尺码拆(面料/散装=否)
  const [sizeOpen, setSizeOpen] = useState(false);      // 尺码录入面板是否展开(即使系统没建议也能手动加码)
  const [newSize, setNewSize] = useState('');           // 手动加尺码输入
  const [sizeSaving, setSizeSaving] = useState(false);
  // ── 产品明细拆分「款号×颜色×尺码」(吊牌/洗唛等印 SKU 信息的辅料;2026-07-10)──
  const [skuOpen, setSkuOpen] = useState(false);          // 产品拆分面板展开
  const [skuActive, setSkuActive] = useState(false);      // DB 已存产品拆分
  const [skuSuggest, setSkuSuggest] = useState<any[]>([]); // 系统按 SKU 件数比例的建议(展开时预填)
  const [skuList, setSkuList] = useState<Array<{ style_no: string; product_name: string; color_cn: string; color_en: string; size: string; qty: string }>>([]);  // 可编辑矩阵
  const [skuSaving, setSkuSaving] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [fulfillment, setFulfillment] = useState<any[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());   // ② 批量确认勾选

  // ── 核料对照表(2026-07-06 用户拍板:大货单耗改由业务在 BOM 页填,采购这里只读核实 + 填抛量%)──
  const [consLines, setConsLines] = useState<any[]>([]);
  const [overEdit, setOverEdit] = useState<Record<string, string>>({});   // 抛量%(采购职权,逐料)
  const [priceEdit, setPriceEdit] = useState<Record<string, string>>({}); // 预算单价(业务填,逐料;2026-07-08 弃报价基线)
  const [supplyEdit, setSupplyEdit] = useState<Record<string, boolean>>({}); // 客供料(来料加工:客户供、绮陌不采购)
  const [styleBudgets, setStyleBudgets] = useState<Array<{ style_no: string; cmt: string }>>([]); // 逐款加工费(元/件)
  const [accessoryTotal, setAccessoryTotal] = useState('');   // 整单辅料总价一口价
  const [accCost, setAccCost] = useState<{ budget: number | null; actual: number; over: number | null; itemsPriced: number; itemsTotal: number } | null>(null);  // 辅料 预算vs实际(采购填价)
  const [consSaving, setConsSaving] = useState(false);
  const loadCons = async () => {
    getAccessoryCostSummary(orderId).then(r => setAccCost((r as any).data ?? null));
    const [r, sb] = await Promise.all([listBomConsumptionLines(orderId), getOrderStyleBudgets(orderId)]);
    if ((r as any).data) {
      setConsLines((r as any).data);
      setOverEdit(Object.fromEntries(((r as any).data as any[]).map(l => [l.id, l.over_purchase_pct != null ? String(l.over_purchase_pct) : ''])));
      setPriceEdit(Object.fromEntries(((r as any).data as any[]).map(l => [l.id, l.budget_unit_price != null ? String(l.budget_unit_price) : ''])));
      setSupplyEdit(Object.fromEntries(((r as any).data as any[]).map(l => [l.id, l.customer_supplied === true])));
    }
    if ((sb as any).data) setStyleBudgets(((sb as any).data as any[]).map(b => ({ style_no: b.style_no, cmt: b.cmt != null ? String(b.cmt) : '' })));
    setAccessoryTotal((sb as any)?.accessoryTotal != null ? String((sb as any).accessoryTotal) : '');
  };
  useEffect(() => { loadCons(); /* eslint-disable-next-line */ }, [orderId]);
  // 布料大货单耗必须由业务填好(BOM 页),否则不许归并
  const consMissing = consLines.filter(l => l.required && !(Number(l.production_consumption) > 0) && !supplyEdit[l.id]);
  async function saveCons() {
    setConsSaving(true); setMsg('');
    // 一次保存:预算单价(业务)+ 逐款加工费 + 整单辅料总价(业务)+ 抛量%(采购,已下单则锁定不重存)
    const over = Object.fromEntries(Object.entries(overEdit).map(([id, v]) => [id, v === '' ? 0 : Number(v)]));
    const prices = Object.fromEntries(Object.entries(priceEdit).map(([id, v]) => [id, v === '' ? null : Number(v)]));
    const sbPayload = styleBudgets.map(b => ({ style_no: b.style_no, cmt: b.cmt === '' ? null : Number(b.cmt) }));
    const accTotal = accessoryTotal === '' ? null : Number(accessoryTotal);
    const tasks: Promise<any>[] = [
      saveBomBudgetUnitPrice(orderId, prices as any),          // 预算单价(业务,任何阶段可填)
      saveOrderStyleBudgets(orderId, sbPayload as any, accTotal), // 逐款加工费 + 整单辅料总价(业务)
      saveBomCustomerSupplied(orderId, supplyEdit),            // 客供料标记(来料加工:绮陌不采购)
    ];
    if (!trackingPhase) tasks.push(saveBomOverPurchasePct(orderId, over as any));  // 抛量:已下单锁定,不重存
    const results = await Promise.all(tasks);
    setConsSaving(false);
    const err = results.map(r => (r as any).error).find(Boolean);
    if (err) { setMsg(err); return; }
    const warn = results.map(r => (r as any).warning).find(Boolean);
    setMsg(warn ? ('⚠️ ' + warn) : '✅ 已保存(预算单价 + 加工费 + 辅料总价' + (trackingPhase ? '' : ' + 抛量') + ')');
    await loadCons();
  }
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

  const [orderPos, setOrderPos] = useState<any[]>([]);   // 该订单的采购单档案(下单后的"下文")
  const reload = async () => {
    const res = await listProcurementItems(orderId);
    const list = (res as any).error ? [] : ((res as any).data || []);
    if ((res as any).error) setMsg((res as any).error); else setItems(list);
    const ff = await getOrderProcurementFulfillment(orderId);
    if ((ff as any).data) setFulfillment((ff as any).data);
    const pos = await getOrderPurchaseOrders(orderId);
    if ((pos as any).data) setOrderPos((pos as any).data);
    // 各采购项的库存可用量(按 consolidation_key)
    const keys = list.map((i: any) => i.consolidation_key).filter(Boolean);
    if (keys.length) {
      const av = await getAvailableStockByKeys(keys);
      if ((av as any).data) setAvail((av as any).data);
    }
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);
  // 带 ?item= 聚焦进来:首次加载到该料时自动展开其明细(找不到=已被归并/删除,退回全部,不留空白)
  useEffect(() => {
    if (autoSelected.current || !focus || items.length === 0) return;
    autoSelected.current = true;
    const it = items.find(i => i.id === focus);
    if (it) select(it); else setFocus(null);
    /* eslint-disable-next-line */
  }, [items, focus]);

  // 删除整条采购项(仅草稿;连带清未归单执行行)
  async function delItem(it: any) {
    if (!(await confirm({ title: `删除采购项 ${it.item_no || it.material_name || ''}？`, message: '仅草稿可删,连带清掉未归采购单的执行行。此操作不可撤销。', danger: true, confirmText: '删除' }))) return;
    const r = await deleteProcurementItemRow(it.id);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg('✅ 已删除采购项'); if (selId === it.id) setSelId(null); await reload();
  }

  const confirmedCount = items.filter(i => i.status === 'confirmed').length;
  const [linesReady, setLinesReady] = useState(false);   // 生成执行行后亮"去归采购单"通路
  // 大货单耗核定表折叠:核定完(或已下单锁定)默认收起,留一行;还有缺的默认展开催填。null=跟随默认,布尔=手动。
  const [consOpen, setConsOpen] = useState<boolean | null>(null);
  async function genLines() {
    setBusy(true); setMsg('');
    const res = await generateExecutionLines(orderId);
    setBusy(false);
    if ((res as any).error) {
      const em = String((res as any).error || '');
      setMsg(/RLS|无权操作|权限/.test(em)
        ? `${em} — 采购角色操作执行行需先在 Supabase 执行 20260703_pli_procurement_access.sql`
        : em);
      return;
    }
    setLinesReady(true);
    setMsg((res as any).created > 0 ? `✅ 已生成 ${(res as any).created} 条采购执行行` : ((res as any).message || '执行行已就绪'));
    await reload();
  }

  // 一次性清理:把历史按尺码拆开的执行行合并回「每料一条」(2026-07-09 用户拍板 B)
  async function mergeSizes() {
    if (!(await confirm({
      title: '合并同料尺码行?',
      message: '把本单历史按尺码拆开的执行行合并成「每料一条」(数量求和、清尺码、取最保守状态)。\n已收货的料不动;PO 应付总额不变。用于治历史拆码遗留,合并后待催货/待送货不再一料多行。',
      confirmText: '合并',
    }))) return;
    setBusy(true); setMsg('');
    const res = await mergeSplitExecutionLines(orderId);
    setBusy(false);
    if ((res as any).error) { setMsg('❌ ' + (res as any).error); return; }
    const r = res as any;
    setMsg(`✅ 合并完成:${r.mergedGroups || 0} 个料合并、清掉 ${r.deleted || 0} 条拆码行${r.skipped?.length ? `;跳过 ${r.skipped.length}(${r.skipped[0]})` : ''}`);
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
    setMsg(`✅ 归并完成:新增 ${(res as any).created} / 刷新 ${(res as any).updated}${(res as any).syncedLines ? ` / 同步未下单执行行数量 ${(res as any).syncedLines}` : ''}${(res as any).flagged ? ` / 已下单量变动·标记需重确认 ${(res as any).flagged}(走补数量)` : ''}${(res as any).removed ? ` / 清理孤儿 ${(res as any).removed}` : ''}`);
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

  // 用库存抵扣(2026-07-03 做透):预留锁定尾料 + 记库存抵扣量 + 减采购量 + 备注(不采购,发货领用核销)
  async function deductStock(item: any) {
    setSaving(true); setMsg('');
    const res = await deductFromStock(item.id, orderId);
    setSaving(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    const d = res as any;
    setMsg(`✅ 库存抵扣 ${d.deducted}${item.unit || ''}(已预留锁定给本单,不采购,发货领用核销)→ 剩余采购 ${d.remaining}${item.unit || ''}${d.remaining === 0 ? '(全用库存,不下单)' : ''}`);
    await reload();
  }

  async function select(item: any) {
    if (selId === item.id) { setSelId(null); return; }
    setSelId(item.id); setSources([]); setSizeBreakdown([]); setSizeEdit({}); setSizeOverrideActive(false); setSuggestedSplit([]); setSizeOpen(false); setNewSize('');
    setSkuOpen(false); setSkuActive(false); setSkuSuggest([]); setSkuList([]);
    const f: Record<string, any> = {};
    for (const k of FORM_KEYS) f[k] = item[k] ?? '';
    // 采购计量单位默认=该项单位(物料录入时就选过,不让采购重敲;按匹/按卷等买法不同才改)
    if (!f.purchase_unit) f.purchase_unit = item.unit || '';
    setForm(f);
    const res = await getProcurementItemSources(item.id);
    if ((res as any).data) setSources((res as any).data);
    const bd = ((res as any).sizeBreakdown || []) as Array<{ size: string | null; qty: number }>;
    setSizeBreakdown(bd);
    setSizeEdit(Object.fromEntries(bd.filter(s => s.size != null).map(s => [s.size as string, String(s.qty)])));
    setSuggestedSplit(((res as any).suggestedSplit || []) as Array<{ size: string | null; qty: number }>);
    setSplittable((res as any).splittable !== false);
    // 产品拆分状态(优先:产品拆分时 size_qty_override 是其派生影子,不单独展开尺码面板)
    const skuA = !!(res as any).skuActive;
    setSizeOverrideActive(!skuA && !!(res as any).sizeOverrideActive);
    setSkuActive(skuA); setSkuSuggest(((res as any).skuSuggest || []) as any[]);
    setSkuList(skuA ? toSkuList((res as any).skuSaved || []) : []); setSkuOpen(skuA);
    setSizeOpen(!skuA && bd.some(s => s.size != null));   // 已存尺码拆分(非产品派生)→ 展开面板
  }
  // 重新拉取当前项的尺码拆分(保存/恢复后刷新预览,不切换选中)
  async function refreshSizes(itemId: string) {
    const res = await getProcurementItemSources(itemId);
    if ((res as any).data) setSources((res as any).data);
    const bd = ((res as any).sizeBreakdown || []) as Array<{ size: string | null; qty: number }>;
    setSizeBreakdown(bd);
    const skuA = !!(res as any).skuActive;
    setSkuActive(skuA); setSkuSuggest(((res as any).skuSuggest || []) as any[]);
    if (skuA) { setSkuList(toSkuList((res as any).skuSaved || [])); setSkuOpen(true); setSizeOpen(false); } else { setSkuList([]); }
    setSizeEdit(Object.fromEntries(bd.filter(s => s.size != null).map(s => [s.size as string, String(s.qty)])));
    setSizeOverrideActive(!skuA && !!(res as any).sizeOverrideActive);
    setSuggestedSplit(((res as any).suggestedSplit || []) as Array<{ size: string | null; qty: number }>);
    setSplittable((res as any).splittable !== false);
  }
  // 保存尺码拆分(采购在预览直接改比例/每码数量)
  async function saveSizes() {
    if (!selId) return;
    setSizeSaving(true); setMsg('');
    const sizes = Object.fromEntries(Object.entries(sizeEdit).map(([k, v]) => [k, v === '' ? 0 : Number(v)]));
    const r = await saveSizeQtyOverride(selId, orderId, sizes as any);
    setSizeSaving(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg(`✅ 尺码拆分已保存(最终采购量 ${(r as any).total})`);
    set('final_purchase_qty', String((r as any).total));   // 同步「最终采购量(人拍板)」输入
    await Promise.all([reload(), refreshSizes(selId)]);
  }
  // 取消尺码拆分(清空人工录入)→ 回到整单一个数量、不分尺码(2026-07-08 用户:默认不拆码)
  async function resetSizes() {
    if (!selId) return;
    setSizeSaving(true); setMsg('');
    const r = await saveSizeQtyOverride(selId, orderId, {});
    setSizeSaving(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setSizeEdit({}); setSizeOpen(false); setNewSize('');   // 收起录入框,回到「按尺码录入」入口
    setMsg('✅ 已改回整单一个数量(不分尺码)');
    await Promise.all([reload(), refreshSizes(selId)]);
  }
  // 展开产品拆分:首次展开用系统建议预填(款×色×码矩阵)
  function openSku() {
    setSkuOpen(true);
    if (skuList.length === 0 && skuSuggest.length > 0) setSkuList(toSkuList(skuSuggest));
  }
  // 保存产品明细拆分(款×色×码)——各码合计自动同步尺码,最终采购量=各格之和
  async function saveSku() {
    if (!selId) return;
    setSkuSaving(true); setMsg('');
    const cells = skuList.map(c => ({ ...c, qty: c.qty === '' ? 0 : Number(c.qty) }));
    const r = await saveSkuBreakdown(selId, orderId, cells as any);
    setSkuSaving(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg(`✅ 产品明细拆分已保存(最终采购量 ${(r as any).total})`);
    set('final_purchase_qty', String((r as any).total));   // 同步「最终采购量(人拍板)」
    await Promise.all([reload(), refreshSizes(selId)]);
  }
  // 取消产品拆分 → 清空矩阵,回到不按产品拆
  async function cancelSku() {
    if (!selId) return;
    setSkuSaving(true); setMsg('');
    const r = await saveSkuBreakdown(selId, orderId, []);
    setSkuSaving(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setSkuList([]); setSkuOpen(false);
    setMsg('✅ 已取消产品明细拆分');
    await Promise.all([reload(), refreshSizes(selId)]);
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
    if (!sel || !(await confirm({ title: '移除这张图?', message: '不删除原文件,只从此项摘掉', danger: true, confirmText: '移除' }))) return;
    const next = (Array.isArray(sel.image_urls) ? sel.image_urls : []).filter((u: string) => u !== url);
    const res = await updateProcurementItemImages(sel.id, orderId, next);
    if ((res as any).error) { setMsg((res as any).error); return; }
    await reload();
  }

  // ── 排版稿/文件附件(分款吊卡/箱唛等;PDF/AI/CDR/xlsx…业务传→采购带过来,双方可补删)──
  const [attBusy, setAttBusy] = useState(false);
  async function uploadItemAttachment(file: File) {
    if (!sel) return;
    if (file.size > 50 * 1024 * 1024) { setMsg('❌ 文件超过 50MB'); return; }
    setAttBusy(true); setMsg('');
    try {
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
      const path = `procurement/${orderId}/attach/${sel.id}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (error) { setMsg('上传失败:' + error.message); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      const next = [...(Array.isArray(sel.attachment_files) ? sel.attachment_files : []), { name: file.name, url: data.publicUrl }].slice(0, 12);
      const res = await updateProcurementItemAttachments(sel.id, orderId, next);
      if ((res as any).error) { setMsg((res as any).error); return; }
      await reload();
    } finally { setAttBusy(false); }
  }
  async function removeItemAttachment(url: string) {
    if (!sel || !(await confirm({ title: '移除这个附件?', message: '不删除原文件,只从此项摘掉', danger: true, confirmText: '移除' }))) return;
    const next = (Array.isArray(sel.attachment_files) ? sel.attachment_files : []).filter((f: any) => f?.url !== url);
    const res = await updateProcurementItemAttachments(sel.id, orderId, next);
    if ((res as any).error) { setMsg((res as any).error); return; }
    await reload();
  }

  // 数量补:对已有项申请补量(业务执行提交;服务端角色把关)
  async function requestSupp(item: any) {
    const v = await prompt({
      title: `补采购「${item.material_name || ''}」`,
      fields: [
        { name: 'qty', label: '补多少', type: 'number', required: true, suffix: item.unit || '同原项', placeholder: '只填数字' },
        { name: 'reason', label: '补采购原因(财务审批要看)', type: 'textarea', required: true, placeholder: '如「生产损耗超标」「裁剪数量不够」' },
      ],
      confirmText: '提交申请',
    });
    if (!v) return;
    const res = await requestSupplementQty(orderId, item.id, Number(v.qty), v.reason);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(`✅ 补料申请已提交(${(res as any).itemNo}),已通知财务审批`);
    await reload();
  }

  // 财务审批补采购(服务端仅财务/管理员可批)
  async function approveBaseline(item: any, ok: boolean) {
    let rejectReason: string | undefined;
    if (!ok) {
      const r = await prompt({ title: '驳回超预算', fields: [{ name: 'reason', label: '驳回原因', type: 'textarea', required: true }], confirmText: '确认驳回' });
      if (!r) return;
      rejectReason = r.reason;
    } else if (!(await confirm({
      title: `批准超预算「${item.material_name}」?`,
      message: `${item.baseline_over_note || ''} · 批准后采购方可确认/下单`,
      confirmText: '批准',
    }))) {
      return;
    }
    const res = await approveBaselineOver(item.id, ok, rejectReason);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(ok ? '✅ 已批准超预算,采购可确认' : '已驳回超预算');
    await reload();
  }

  async function approveSupp(item: any, ok: boolean) {
    let rejectReason: string | undefined;
    if (!ok) {
      const r = await prompt({ title: '驳回补采购', fields: [{ name: 'reason', label: '驳回原因', type: 'textarea', required: true }], confirmText: '确认驳回' });
      if (!r) return;
      rejectReason = r.reason;
    } else if (!(await confirm({
      title: `批准补采购「${item.material_name}」?`,
      message: `${item.total_required_qty}${item.unit || ''} · 批准后采购部即可确认并执行`,
      confirmText: '批准',
    }))) {
      return;
    }
    const res = await approveSupplement(item.id, ok, rejectReason);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setMsg(ok ? '✅ 已批准,采购部可执行' : '已驳回');
    await reload();
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  const sel = items.find(i => i.id === selId);
  // 聚焦单料:物料表只渲染这一款(进度/归并/核料对照等全局统计仍按整单,口径不变)
  const focusItem = focus ? items.find(i => i.id === focus) : null;
  const visibleItems = focusItem ? [focusItem] : items;

  // ── 阶段判定(2026-07-03 用户拍板:下完单核料转入追踪模式,不再摆工作台) ──
  const ORDERED_PLUS = ['ordered', 'partially_received', 'completed', 'closed'];
  const trackingPhase = items.length > 0 && items.every(i => ORDERED_PLUS.includes(i.status));
  // 核定表默认展开(2026-07-08:预算单价/加工费/辅料要在这填,收起会让用户"找不到输入价格的地方")
  const consEffectiveOpen = consOpen ?? true;

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
    && !(i.is_supplement && i.finance_approval_status !== 'approved')
    // 超预算未获财务批准 → 不可批量确认(与逐项确认闸一致)
    && !(i.baseline && i.baseline.over_price && i.baseline_over_status !== 'approved');
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
    if (!(await confirm({ title: `批量确认 ${ids.length} 项采购?`, message: '有风险/替代/待批补采购的项不在其列,需逐项处理', confirmText: '确认' }))) return;
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

  // ── 采购工作流步骤条(2026-07-05:让没做过采购的人一眼知道"下一步该做什么")──
  const totalItems = items.length;
  const stepIdx = totalItems === 0 ? 0
    : trackingPhase ? 3
    : consMissing.length > 0 ? 0
    : confirmedCount < totalItems ? 1
    : 2;   // 全部已确认 → 生成执行行·归采购单·下单
  const STEPS = ['① 核料对照+抛量', '② 逐项确认', '③ 生成执行行·归采购单·下单', '④ 收货跟单'];
  const nextHint = totalItems === 0 ? '暂无采购核料项(业务提交采购申请后出现)'
    : stepIdx === 0 ? `还有 ${consMissing.length} 条布料·业务未填大货单耗(去「原辅料和包装」页填);填齐后采购在下方逐料填抛量%`
    : stepIdx === 1 ? `${confirmedCount}/${totalItems} 已确认 → 逐项点右侧「确认」(核对物料/颜色/数量/供应商)`
    : stepIdx === 2 ? `全部已确认 → 点「➡️ 生成执行行」,再「去归采购单」勾行建单 → PO 页传凭证「下单」`
    : `料已下单 → 到货后在采购中心「收货登记」;逾期在「待催货」催`;

  return (
    <div className="space-y-4">
      {/* 步骤条 + 下一步高亮 */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {STEPS.map((s, i) => (
            <span key={i} className={`text-[11px] px-2 py-1 rounded-full font-medium ${
              i < stepIdx ? 'bg-emerald-100 text-emerald-700'
              : i === stepIdx ? 'bg-indigo-600 text-white'
              : 'bg-white text-gray-400 border border-gray-200'}`}>
              {i < stepIdx ? '✓ ' : ''}{s}
            </span>
          ))}
        </div>
        <p className="text-xs text-indigo-900"><b>👉 下一步:</b>{nextHint}</p>
      </div>
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
        <div className="flex items-center gap-2 flex-wrap">
          {trackingPhase ? (
            <span className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-500" title="全部采购项已下单;核定/归并已锁定,改量走「补数量申请」">
              🔒 已全部下单 — 进入跟单追踪(下方采购单档案)
            </span>
          ) : (<>
            {confirmedCount > 0 && (
              <button onClick={genLines} disabled={busy}
                className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
                title="把已确认采购项生成采购执行行(下单/收货用)">
                {busy ? '生成中…' : `➡️ 生成执行行（${confirmedCount} 已确认）`}</button>
            )}
            <button onClick={consolidate} disabled={busy}
              className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
              {busy ? '核料中…' : '🔄 核料归并 / 刷新'}</button>
          </>)}
          {/* 合并尺码行:治历史拆码遗留,任何阶段可用(已下单/追踪期也常见拆码堆积) */}
          <button onClick={mergeSizes} disabled={busy}
            className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50 disabled:opacity-50"
            title="把历史按尺码拆开的执行行合并回每料一条(治遗留;已收货的不动,PO应付不变)">
            {busy ? '处理中…' : '🧹 合并尺码行'}</button>
        </div>
      </div>
      {msg && <p className="text-xs text-gray-600">{msg}</p>}

      {/* 采购单档案(下单后的追踪主体:PO为单位,批次历史在PO详情) */}
      {orderPos.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 text-sm font-semibold text-gray-700">🧾 本单采购单档案({orderPos.length})<span className="font-normal text-xs text-gray-400"> · 每批收货/催货记录点进采购单看</span></div>
          {orderPos.map(p => (
            <Link key={p.id} href={`/procurement/po/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 text-xs">
              <span className="font-mono font-semibold text-indigo-700">{p.po_no}</span>
              <span className="text-gray-600">{p.supplier_name || '—'}</span>
              <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">{({ draft: '草稿', placed: '已下单', confirmed: '已确认', receiving: '收货中', received: '已收齐', closed: '关闭', cancelled: '取消' } as Record<string, string>)[p.status] || p.status}</span>
              <span className="text-gray-400">{p.line_count} 行 · 订购 {p.ordered_sum}</span>
              <span className="text-emerald-700">已收 {p.received_sum}</span>
              {p.outstanding_sum > 0
                ? <span className="font-semibold text-amber-600">未到 {p.outstanding_sum}</span>
                : <span className="text-emerald-600">✓ 收齐</span>}
              <span className="ml-auto text-indigo-500">查看档案 →</span>
            </Link>
          ))}
        </div>
      )}

      {/* ⓪ 按款核定大货单耗(布料必核;不核定完不能归并——归并=Σ 每款件数×该款大货单耗) */}
      {consLines.length > 0 && (
        <div className={`rounded-xl border-2 p-3 space-y-2 ${consMissing.length > 0 ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-800">📐 核料对照(业务填预算单价 · 采购填抛量)</span>
            {trackingPhase
              ? <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">🔒 已下单,锁定(存档;改量走「补数量申请」)</span>
              : consMissing.length > 0
                ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">🔒 还差 {consMissing.length} 条布料·业务未填大货单耗 — 业务在「原辅料和包装」页填完才能归并</span>
                : <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">✅ 大货单耗齐,可归并</span>}
            {consMissing.length === 0 && (
              <button onClick={() => setConsOpen(!consEffectiveOpen)}
                className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">
                {consEffectiveOpen ? '收起 ▲' : `展开复核 / 修改（${consLines.length}）▼`}
              </button>
            )}
            {consEffectiveOpen && (
              <button onClick={saveCons} disabled={consSaving}
                className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
                {consSaving ? '保存中…' : '💾 保存核料预算'}
              </button>
            )}
          </div>
          {consEffectiveOpen && <>
          <p className="text-[11px] text-gray-500">大货单耗由业务在「原辅料和包装」页按技术部大货版逐款填(此处<b>只读核实</b>);业务给<b>布料</b>逐料填<b>预算单价</b>(面料预算=大货单耗×预算单价×件数);辅料不逐个填价,走下方<b>整单辅料总价</b>(一口价);采购逐料填<b>抛量%</b>。采购量 = Σ(件数 × 大货单耗) ×(1 + 抛量%)。</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-400">
                {['款号', '颜色', '物料', '类型', '客供', '数量', '开发单耗', '大货单耗', '预算单价(业务填)', '抛量%(采购填)', '单位'].map(h => (
                  <th key={h} className="py-1.5 px-2 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {consLines.map(l => (
                  <tr key={l.id} className={`border-t border-gray-100 ${l.required && !(Number(l.production_consumption) > 0) && !supplyEdit[l.id] ? 'bg-amber-50' : ''} ${supplyEdit[l.id] ? 'bg-sky-50/60' : ''}`}>
                    <td className="py-1.5 px-2 font-mono">{l.style_no || '—'}</td>
                    <td className="py-1.5 px-2">{l.color || '—'}</td>
                    <td className="py-1.5 px-2 text-gray-800">{l.material_name || '—'}</td>
                    <td className="py-1.5 px-2">{l.required ? <span className="text-amber-700 font-medium">布料·必核</span> : <span className="text-gray-400">辅料·可选</span>}</td>
                    {/* 客供:勾了=客户供、绮陌不采购(不进采购/应付/面料成本),仅留规格用量给生产 */}
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      <label className="inline-flex items-center gap-1 cursor-pointer" title="客户供料(来料加工):勾上后绮陌不采购此料、不进应付、财务不计其成本;仍保留规格/用量给生产">
                        <input type="checkbox" checked={!!supplyEdit[l.id]} disabled={trackingPhase}
                          onChange={e => setSupplyEdit(prev => ({ ...prev, [l.id]: e.target.checked }))}
                          className="rounded border-gray-300" />
                        {supplyEdit[l.id] && <span className="text-[11px] text-sky-700 font-medium">客供</span>}
                      </label>
                    </td>
                    <td className="py-1.5 px-2 font-medium text-gray-800" title="该款×色件数(整单通用辅料=订单总数)">{l.pieces ?? '—'}</td>
                    <td className="py-1.5 px-2 text-gray-500">{l.development_consumption ?? '—'}</td>
                    {/* 大货单耗:业务在 BOM 页填,采购这里只读核实 */}
                    <td className="py-1.5 px-2">
                      {Number(l.production_consumption) > 0
                        ? <span className="font-medium text-gray-800">{l.production_consumption}</span>
                        : (l.required && !supplyEdit[l.id]) ? <span className="text-[11px] text-amber-600">业务未填 →</span> : <span className="text-gray-300">—</span>}
                    </td>
                    {/* 预算单价:仅布料填(面料预算=大货单耗×本列×件数);辅料不逐个填价,走下方「辅料总价」;客供料绮陌不买 → 免填 */}
                    <td className="py-1.5 px-2">
                      {supplyEdit[l.id] ? <span className="text-[11px] text-sky-600">客供·绮陌不采购</span>
                        : l.required ? (<>
                        <span className="text-gray-400 mr-0.5">¥</span>
                        <input type="number" step="any" min="0" value={priceEdit[l.id] ?? ''}
                          placeholder="必填"
                          onChange={e => setPriceEdit(prev => ({ ...prev, [l.id]: e.target.value }))}
                          className={`w-20 rounded border px-2 py-1 ${!(Number(priceEdit[l.id]) > 0) ? 'border-amber-300 bg-amber-50' : 'border-gray-300'}`} />
                      </>) : <span className="text-gray-300">—</span>}
                    </td>
                    {/* 抛量%:采购填,采购量=件数×大货单耗×(1+抛量%) */}
                    <td className="py-1.5 px-2">
                      <input type="number" step="1" min="0" value={overEdit[l.id] ?? ''} disabled={trackingPhase}
                        placeholder="0"
                        onChange={e => setOverEdit(prev => ({ ...prev, [l.id]: e.target.value }))}
                        className="w-16 rounded border border-gray-300 px-2 py-1 disabled:bg-gray-50 disabled:text-gray-500" />
                      <span className="text-[11px] text-gray-400 ml-0.5">%</span>
                    </td>
                    <td className="py-1.5 px-2 text-gray-400">{l.unit || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 逐款加工费(元/件)+ 整单辅料总价一口价(2026-07-08 用户拍板)*/}
          {styleBudgets.length > 0 && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 mt-2 space-y-2">
              <div className="text-xs font-semibold text-indigo-800">🧵 逐款加工费(元/件,业务填)· 加工费预算 = 加工费 × 该款件数</div>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead><tr className="text-left text-gray-400">
                    {['款号', '加工费(元/件)'].map(h => <th key={h} className="py-1 px-2 font-medium whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {styleBudgets.map((b, i) => (
                      <tr key={i} className="border-t border-indigo-100">
                        <td className="py-1 px-2 font-mono text-gray-700">{b.style_no}</td>
                        <td className="py-1 px-2"><span className="text-gray-400 mr-0.5">¥</span>
                          <input type="number" step="any" min="0" value={b.cmt}
                            onChange={e => setStyleBudgets(sb => sb.map((x, j) => j === i ? { ...x, cmt: e.target.value } : x))}
                            className="w-20 rounded border border-gray-300 px-2 py-1" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-indigo-100">
                <span className="text-xs font-semibold text-indigo-800">🧷 整单辅料总价(业务预算)</span>
                <span className="text-gray-400 text-sm">¥</span>
                <input type="number" step="any" min="0" value={accessoryTotal}
                  placeholder="全单辅料合并一口价" disabled={trackingPhase}
                  onChange={e => setAccessoryTotal(e.target.value)}
                  className="w-40 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50 disabled:text-gray-500" />
                <span className="text-[11px] text-gray-400">业务给的辅料预算一口价(不按款/件数)</span>
              </div>
              {/* 实际辅料总价(采购填的单价×数量,填了即算;2026-07-08 用户拍板 A)*/}
              {accCost && (accCost.itemsTotal > 0) && (
                <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-indigo-100 text-xs">
                  <span className="font-semibold text-emerald-800">💰 实际辅料总价</span>
                  <span className="font-mono font-semibold text-emerald-700">¥{accCost.actual.toLocaleString()}</span>
                  <span className="text-gray-400">(采购填价 · {accCost.itemsPriced}/{accCost.itemsTotal} 项已填单价)</span>
                  {accCost.over != null && accCost.budget != null && (
                    accCost.over > 0
                      ? <span className="px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 font-medium">⚠️ 超预算 ¥{accCost.over.toLocaleString()}</span>
                      : <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">✅ 省 ¥{Math.abs(accCost.over).toLocaleString()}</span>
                  )}
                  <span className="text-gray-400">已同步财务</span>
                </div>
              )}
            </div>
          )}
          </>}
        </div>
      )}

      {/* 确认后的下文(2026-07-03 用户拍板:确认→采购单→给供应商→财务→追踪 一条路走亮;下单后由采购单档案接棒) */}
      {(linesReady || confirmedCount > 0) && !trackingPhase && (
        <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-emerald-900">
            {linesReady ? '执行行已就绪,下一步:归成采购单发供应商' : '已确认的项:先点上方「➡️ 生成执行行」,再归采购单'}
          </span>
          <Link href="/procurement/po/new"
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700">
            🧾 去归采购单 →
          </Link>
          <span className="text-xs text-emerald-700">
            归单页勾选执行行 → 建采购单 → 点「下单」(财务自动收到应付+付款计划,行进入待催货追踪) → 「导出采购单(含价)」发供应商 / 无价版发内部
          </span>
        </div>
      )}

      {/* 聚焦单料横幅:从采购中心点某行「任务单」带 ?item= 进来时,只看这一款料;一键切回整单 */}
      {focusItem && (
        <div className="flex items-center gap-3 flex-wrap rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-2.5">
          <span className="text-sm text-indigo-900">
            🔎 只看这一款料:<b>{focusItem.material_name || focusItem.item_no || '—'}</b>
            {focusItem.color ? <span className="ml-1 text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">{focusItem.color}</span> : null}
          </span>
          <button onClick={() => { setFocus(null); setSelId(null); }}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-indigo-300 bg-white text-indigo-700 font-medium hover:bg-indigo-50">
            查看全部物料（{items.length}）
          </button>
        </div>
      )}
      {/* 聚焦进来但该料已不在清单(被归并/删除):提示并给回退,不留空白页 */}
      {focus && !focusItem && items.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span>该料已被归并或删除,已为你显示整单物料。</span>
          <button onClick={() => setFocus(null)} className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-700 font-medium hover:bg-amber-100">查看全部物料（{items.length}）</button>
        </div>
      )}

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
              {['☑', '编号', '内部订单号', '物料', '类别', '颜色', '单位', '总需求', '库存可用', '来源', '建议采购', '最终', '供应商', '状态', ''].map(h => (
                <th key={h} className="py-2 px-2 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {visibleItems.map(it => (
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
                  <td className="py-2 px-2 font-mono text-xs text-gray-500 whitespace-nowrap">{internalOrderNo || '—'}</td>
                  <td className="py-2 px-2 font-medium text-gray-900">
                    <span className="inline-flex items-center gap-1.5">
                      {Array.isArray(it.image_urls) && it.image_urls[0] && (
                        <img src={it.image_urls[0]} alt="" className="w-7 h-7 rounded object-cover border border-gray-200 shrink-0" />
                      )}
                      {it.material_name || '—'}
                    </span>
                    {it.baseline && it.baseline.over_price && (
                      <span
                        title={`采购单价 超预算 +${it.baseline.price_over_pct}%（预算单价 ¥${it.baseline.quote_unit_price}）· 超预算需财务审批`}
                        className="ml-1 inline-block px-1.5 py-px rounded text-[10px] font-medium bg-rose-100 text-rose-700 align-middle">
                        ⚠超预算·价+{it.baseline.price_over_pct}%
                      </span>
                    )}
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
                  <td className="py-2 px-2 whitespace-nowrap">
                    <span className="text-xs text-indigo-600">{selId === it.id ? '收起' : '展开'}</span>
                    {it.status === 'draft' && (
                      <button onClick={e => { e.stopPropagation(); delItem(it); }}
                        title="删除整条(仅草稿可删)" className="ml-2 text-xs text-red-500 hover:text-red-700 hover:underline">删除</button>
                    )}
                  </td>
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
                {['物料', '颜色', '状态', '需求', '下单', '收货', '消耗(领料)', '尾货', '单位'].map(h => (
                  <th key={h} className="py-1.5 px-2 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {fulfillment.filter(f => f.ordered > 0 || f.received > 0 || f.consumed > 0).map(f => (
                  <tr key={f.procurement_item_id} className="border-b border-gray-50">
                    <td className="py-1.5 px-2 text-gray-800">{f.material_name || '—'}</td>
                    <td className="py-1.5 px-2 text-gray-600">{f.color || '—'}</td>
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

          {/* 超报价基线 + 财务审批(P2b:超单耗/超价 → 未批不能确认)*/}
          {((sel.baseline && (sel.baseline.over_consumption || sel.baseline.over_price)) || sel.baseline_over_status) && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-rose-800">🔴 超报价基线</span>
                {sel.baseline_over_status && (
                  <span className={`px-2 py-0.5 rounded-full font-medium ${SUPP_STATUS[sel.baseline_over_status]?.cls || 'bg-amber-100 text-amber-700'}`}>
                    {SUPP_STATUS[sel.baseline_over_status]?.label || sel.baseline_over_status}
                  </span>
                )}
                {sel.baseline_over_status === 'pending' && <>
                  <button onClick={() => approveBaseline(sel, true)}
                    className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">✅ 批准(财务)</button>
                  <button onClick={() => approveBaseline(sel, false)}
                    className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700">✖ 驳回(财务)</button>
                </>}
              </div>
              <p className="text-rose-700">
                {sel.baseline_over_note
                  || [sel.baseline?.over_consumption ? `大货单耗超报价 +${sel.baseline.consumption_over_pct}%(报价 ${sel.baseline.quote_consumption})` : '',
                      sel.baseline?.over_price ? `采购单价超报价 +${sel.baseline.price_over_pct}%` : ''].filter(Boolean).join(' · ')}
              </p>
              {sel.baseline_over_status === 'rejected' && sel.baseline_over_reject_reason && (
                <p className="text-red-600">驳回原因:{sel.baseline_over_reject_reason}</p>
              )}
              {(!sel.baseline_over_status || sel.baseline_over_status === 'pending') && (
                <p className="text-rose-600">超报价基线需财务审批;确认采购时会自动提交并通知财务,批准后才能确认→下单。</p>
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

          {/* 排版稿/文件附件(分款吊卡/箱唛等复杂辅料;业务传的排版稿随归并带过来,双方可补删)*/}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500">📎 排版稿 / 文件附件({(sel.attachment_files || []).length})<span className="font-normal text-gray-400"> · 分款吊卡/箱唛等每款排版不同 → 传做好的稿(PDF/AI/CDR/xlsx…),进采购单附件清单发供应商</span></span>
              <label className={`text-xs px-2.5 py-1 rounded-lg cursor-pointer font-medium ${attBusy ? 'bg-gray-100 text-gray-400' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}>
                {attBusy ? '上传中…' : '📎 上传附件'}
                <input type="file" accept=".pdf,.ai,.cdr,.eps,.svg,.psd,.xlsx,.xls,.csv,.doc,.docx,.zip,.rar,.png,.jpg,.jpeg" className="hidden" disabled={attBusy}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadItemAttachment(f); }} />
              </label>
            </div>
            {(sel.attachment_files || []).length === 0 ? (
              <p className="text-xs text-gray-400">暂无附件 — 业务在「原辅料」上传排版稿后点「核料归并/刷新」会自动带入;或直接点上方上传</p>
            ) : (
              <ul className="space-y-1">
                {(sel.attachment_files as Array<{ name: string; url: string }>).map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <a href={f.url} target="_blank" rel="noreferrer" download
                      className="text-indigo-600 hover:underline truncate max-w-[26rem]" title={f.name}>📄 {f.name}</a>
                    <button onClick={() => removeItemAttachment(f.url)} title="移除"
                      className="text-gray-300 hover:text-rose-500 leading-none shrink-0">×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 采购规格(供应商-facing;采购员自填·自由多行)——进采购单发供应商,整个辅料一份 */}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-gray-500">📋 采购规格<span className="font-normal text-gray-400"> · 发供应商的规格(尺寸/材质/工艺…);整个辅料一份,改后点下方「保存」</span></span>
            </div>
            <textarea value={form.purchase_spec ?? ''} onChange={e => set('purchase_spec', e.target.value)}
              rows={3} placeholder="例:吊牌 80×40mm · 300g 铜版纸 · 双面四色印 + 过哑膜 · 棉绳吊绳"
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            <p className="mt-1 text-[11px] text-gray-400">此规格 + 上方图片会一起进「采购单 → 辅料规格&图片」附页,直接发供应商照做。</p>
          </div>

          {/* 尺码 opt-in(2026-07-08:辅料默认整单一个数量;点此打开逐码录入。系统有建议则预填,没建议也能手动加码)*/}
          {!sizeOpen && !skuOpen && !skuActive && splittable && sel && !['ordered', 'partially_received', 'completed', 'closed'].includes(sel.status) && (
            <button onClick={() => { setSizeOpen(true); if (Object.keys(sizeEdit).length === 0 && suggestedSplit.length > 0) setSizeEdit(Object.fromEntries(suggestedSplit.filter(s => s.size != null).map(s => [s.size as string, String(s.qty)]))); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-teal-300 text-teal-700 hover:bg-teal-50 font-medium">
              ➕ 按尺码录入（默认整单一个数量·不分尺码；点此逐码填量）
            </button>
          )}

          {/* 尺码拆分:可直接改比例/每码数量(2026-07-08 用户拍板)——生成执行行按此逐码出量 */}
          {sizeOpen && (() => {
            const sizeLocked = ['ordered', 'partially_received', 'completed', 'closed'].includes(sel.status);
            const sizeSum = Object.values(sizeEdit).reduce((a, v) => a + (Number(v) || 0), 0);
            return (
            <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3 space-y-2">
              <div className="text-xs font-semibold text-teal-800 flex items-center gap-2 flex-wrap">
                <span>📐 尺码拆分 · 最终采购量 <b>{sizeSum || '—'}</b> {sel.unit || ''}</span>
                {sizeOverrideActive
                  ? <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">✋ 已按尺码</span>
                  : <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">未保存·保存后才按码拆</span>}
                {sizeLocked && <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">🔒 已下单锁定</span>}
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                {Object.keys(sizeEdit).map((sz) => (
                  <label key={sz} className="inline-flex items-center gap-1 rounded-md bg-white border border-teal-200 px-2 py-1 text-xs">
                    <span className="font-semibold text-teal-700">{sz}</span>
                    <input type="number" min="0" step="1" value={sizeEdit[sz]} disabled={sizeLocked}
                      onChange={e => setSizeEdit(prev => ({ ...prev, [sz]: e.target.value }))}
                      className="w-16 rounded border border-gray-300 px-1.5 py-0.5 text-right disabled:bg-gray-50 disabled:text-gray-500" />
                    {!sizeLocked && <button onClick={() => setSizeEdit(prev => { const n = { ...prev }; delete n[sz]; return n; })} className="text-gray-300 hover:text-rose-500 leading-none" title="删除此码">×</button>}
                  </label>
                ))}
                {/* 手动加尺码:系统没建议 / 需要额外码(如洗标要 XL)时用 —— 输码名回车或点 ＋ */}
                {!sizeLocked && (() => {
                  const addSize = () => { const s = newSize.trim(); if (s && !(s in sizeEdit)) { setSizeEdit(prev => ({ ...prev, [s]: '0' })); setNewSize(''); } };
                  return (
                    <span className="inline-flex items-center gap-1 rounded-md bg-white border border-dashed border-teal-300 px-2 py-1 text-xs">
                      <input value={newSize} onChange={e => setNewSize(e.target.value)} placeholder="加尺码(如 XL/均码)"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSize(); } }}
                        className="w-24 rounded border border-gray-300 px-1.5 py-0.5" />
                      <button onClick={addSize} className="text-teal-600 font-bold leading-none" title="加这个码">＋</button>
                    </span>
                  );
                })()}
                {Object.keys(sizeEdit).length === 0 && <span className="text-[11px] text-gray-400">系统没查到本单尺码 → 在左边手动加码填量(如 S/M/L 或 均码)</span>}
              </div>
              {!sizeLocked && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={saveSizes} disabled={sizeSaving}
                    className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700 disabled:opacity-50">
                    {sizeSaving ? '保存中…' : '💾 保存尺码拆分'}
                  </button>
                  <button onClick={resetSizes} disabled={sizeSaving}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">
                    ↺ 取消尺码（整单一个数量）
                  </button>
                  <span className="text-[11px] text-teal-600">逐码填量;最终采购量 = 各码之和,生成采购行时按此逐码出量。不需要分尺码就点「取消尺码」。</span>
                </div>
              )}
            </div>
            );
          })()}

          {/* 产品明细拆分:款号×颜色×尺码(吊牌/洗唛等印 SKU 信息的辅料;2026-07-10)*/}
          {splittable && sel && (() => {
            const locked = ['ordered', 'partially_received', 'completed', 'closed'].includes(sel.status);
            // 入口按钮:未按产品、未展开、未按尺码(与尺码互斥)、未锁定时显示
            if (!skuOpen && !skuActive) {
              if (sizeOverrideActive || sizeOpen || locked) return null;
              return (
                <button onClick={openSku}
                  className="text-xs px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-medium">
                  🏷 按产品拆分（款号×颜色×尺码 · 吊牌/洗唛印 SKU 信息用）
                </button>
              );
            }
            if (!skuOpen) return null;
            // 由可编辑列表构建矩阵:行=款号+颜色,列=尺码
            const rowsMap = new Map<string, { style_no: string; product_name: string; color_cn: string; color_en: string }>();
            const sizes: string[] = [];
            for (const c of skuList) {
              const rk = `${c.style_no}§${c.color_cn}§${c.color_en}`;
              if (!rowsMap.has(rk)) rowsMap.set(rk, c);
              if (c.size && !sizes.includes(c.size)) sizes.push(c.size);
            }
            const rows = [...rowsMap.values()];
            const cellOf = (r: any, size: string) => skuList.find(c => c.style_no === r.style_no && c.color_cn === r.color_cn && c.color_en === r.color_en && c.size === size);
            const setQty = (r: any, size: string, val: string) => setSkuList(prev => prev.map(c => (c.style_no === r.style_no && c.color_cn === r.color_cn && c.color_en === r.color_en && c.size === size) ? { ...c, qty: val } : c));
            const total = skuList.reduce((a, c) => a + (Number(c.qty) || 0), 0);
            return (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 space-y-2">
                <div className="text-xs font-semibold text-indigo-800 flex items-center gap-2 flex-wrap">
                  <span>🏷 产品明细拆分（款×色×码）· 最终采购量 <b>{total || '—'}</b> {sel.unit || ''}</span>
                  {skuActive
                    ? <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">✋ 已按产品</span>
                    : <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">未保存·保存后才按产品拆</span>}
                  {locked && <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">🔒 已下单锁定</span>}
                </div>
                {rows.length === 0 ? (
                  <p className="text-[11px] text-gray-400">本单没有款号×颜色×尺码明细（订单逐款录入为空），无法按产品拆。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="text-xs border-collapse">
                      <thead>
                        <tr className="text-indigo-700">
                          <th className="py-1 px-2 text-left font-medium border border-indigo-100 bg-white whitespace-nowrap">款号 / 颜色</th>
                          {sizes.map(s => <th key={s} className="py-1 px-2 font-medium border border-indigo-100 bg-white text-center">{s}</th>)}
                          <th className="py-1 px-2 font-medium border border-indigo-100 bg-white text-center">小计</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, ri) => {
                          const rowSum = sizes.reduce((a, s) => { const c = cellOf(r, s); return a + (c ? Number(c.qty) || 0 : 0); }, 0);
                          return (
                            <tr key={ri}>
                              <td className="py-1 px-2 border border-indigo-100 bg-white whitespace-nowrap">
                                <span className="font-semibold text-gray-700">{r.style_no || '—'}</span>
                                <span className="text-gray-400"> / {r.color_cn || r.color_en || '—'}</span>
                                {r.product_name && <span className="text-gray-300"> · {r.product_name}</span>}
                              </td>
                              {sizes.map(s => {
                                const c = cellOf(r, s);
                                return (
                                  <td key={s} className="border border-indigo-100 bg-white text-center p-0">
                                    {c ? (
                                      <input type="number" min="0" step="1" value={c.qty} disabled={locked}
                                        onChange={e => setQty(r, s, e.target.value)}
                                        className="w-16 px-1 py-1 text-right disabled:bg-gray-50 disabled:text-gray-500 outline-none" />
                                    ) : <span className="text-gray-200">—</span>}
                                  </td>
                                );
                              })}
                              <td className="py-1 px-2 border border-indigo-100 bg-indigo-50/50 text-center font-medium text-indigo-700">{rowSum}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {!locked && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={saveSku} disabled={skuSaving || rows.length === 0}
                      className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
                      {skuSaving ? '保存中…' : '💾 保存产品明细拆分'}
                    </button>
                    <button onClick={cancelSku} disabled={skuSaving}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">
                      ↺ 取消产品拆分
                    </button>
                    <span className="text-[11px] text-indigo-600">系统按订单各 SKU 件数预填,可改。最终采购量 = 各格之和;各码合计自动同步到尺码,采购单主表按尺码汇总、另附「产品明细」页发供应商。</span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 来源明细(live;粒度=物料行)*/}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="text-xs font-semibold text-gray-500 mb-2">来源明细（{sources.length}）<span className="font-normal text-gray-400">· 物料行粒度;款×色×码拆分见上「产品明细拆分」</span></div>
            {sources.length === 0 ? <p className="text-xs text-gray-400">无来源</p> : (
              <table className="w-full text-xs">
                <thead><tr className="text-gray-400 text-left">{['物料', '款号', '颜色', '开发单耗', '需求量'].map(h => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{sources.map((s, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="py-1 pr-3 text-gray-700">{s.material_name || '—'}</td>
                    <td className="py-1 pr-3 font-mono text-gray-700">{s.style_no || <span className="text-gray-400 font-sans">整单通用</span>}</td>
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
            {/* 汇总级大货单耗已废除(2026-07-03:不同款单耗不同,平均/折算是错的)——改「按款核定大货单耗」表格,总需求=Σ每款件数×该款大货单耗 */}
            {/* 2026-07-07:采购损耗%并入「抛量%」(唯一 buffer),此字段值=抛量%(核料对照①填,归并带过来);不再双 3% */}
            <Field label="抛量%" k="procurement_loss_pct" form={form} set={set} type="number" />
            <Field label="安全库存" k="safety_stock_qty" form={form} set={set} type="number" />
            {/* MOQ 字段撤掉(2026-07-03 用户拍板不需要);列保留,已录过的旧值仍参与建议量取整 */}
            <div>
              <span className="text-gray-500">建议采购(实时算)</span>
              <div className="mt-1 w-full rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 font-semibold text-emerald-800"
                title="采购量 = 总需求(裸数) × (1 + 抛量%) + 安全库存,按 MOQ 向上取整。总需求已是裸数,抛量只在这里算一次(不再双 3%)。">
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
            <label className="block">
              <span className="text-gray-500">需到日(货到厂日 · 采购选)</span>
              <input type="date" value={(form.required_date || '').slice(0, 10)}
                onChange={e => set('required_date', e.target.value)}
                className="w-full mt-1 rounded-lg border border-gray-300 px-2 py-1.5" />
              <span className="text-[10px] text-gray-400">
                采购按供应商能到的日期直接选;缺料风险「需 X 前到」用它。{(() => {
                  const rd = (form.required_date || '').slice(0, 10); const lead = Number(form.lead_days) || 0;
                  if (rd && lead > 0 && /^\d{4}-\d{2}-\d{2}$/.test(rd)) {
                    const [y, m, d] = rd.split('-').map(Number);
                    const obd = new Date(Date.UTC(y, m - 1, d) - lead * 86400000).toISOString().slice(0, 10);
                    return ` 最晚下单 ${obd}(=需到日−交期${lead}天)`;
                  }
                  return ' 留空 = 系统按出厂日−交期自动倒推';
                })()}
              </span>
            </label>
          </div>

          {/* 已用库存抵扣的记录(进采购单·标库存·不采购) */}
          {Number(sel.stock_deduct_qty) > 0 && (() => {
            const gross = Number(sel.final_purchase_qty ?? sel.suggested_purchase_qty) || 0;
            const toBuy = Math.max(0, Math.round((gross - Number(sel.stock_deduct_qty)) * 1000) / 1000);
            return (
              <div className="rounded-lg bg-sky-50 border border-sky-200 p-2.5 text-xs text-sky-800">
                📦 已用库存抵扣 <b>{sel.stock_deduct_qty}</b> {sel.unit || ''}(已预留锁定给本单,<b>不采购</b>,发货时领料核销)
                · 实际向供应商采购 = 定案 {gross} − 库存 {sel.stock_deduct_qty} = <b>{toBuy}</b>{sel.unit || ''}{toBuy === 0 ? '(全用库存,不下单)' : ''}
              </div>
            );
          })()}

          {/* 库存抵扣:该物料有可用尾料 → 一键从最终采购量扣减 */}
          {avail[sel.consolidation_key]?.available > 0 && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-xs flex items-center justify-between gap-2">
              <span className="text-emerald-800">
                📦 库存有 <b>{avail[sel.consolidation_key].available}</b> {sel.unit || ''} 可用
                {avail[sel.consolidation_key].location && <>(库位 {avail[sel.consolidation_key].location})</>}
                ,可抵扣本次采购(减尾料·标库存·不采购)
              </span>
              <button onClick={() => deductStock(sel)} disabled={saving}
                className="shrink-0 px-3 py-1 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">{saving ? '处理中…' : '用库存抵扣'}</button>
            </div>
          )}

          {/* 供应商(从供应商主数据选,不再手敲;选中自动带联系人) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <label className="block">
              <span className="text-gray-500">确认供应商</span>
              <div className="mt-1">
                <SearchableSelect allowFreeText
                  options={supplierOptions.map(s => ({ value: s.name, label: `${s.name}${s.main_category ? `(${s.main_category})` : ''}` }))}
                  value={form.confirmed_supplier_name ?? ''}
                  onChange={(name) => {
                    set('confirmed_supplier_name', name);
                    const sup = supplierOptions.find(s => s.name === name);
                    if (sup?.contact_name && !form.supplier_contact) set('supplier_contact', sup.contact_name);
                  }}
                  placeholder="选择 / 搜索供应商"
                  className="w-full rounded-lg border border-gray-300 px-2 py-1.5 bg-white" />
              </div>
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

          {/* 价格(单价带报价基线预算参考:采购填价时实时判断是否超预算 —— 2026-07-08 用户拍板) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            {(() => {
              const budPrice = sel.baseline?.quote_unit_price != null ? Number(sel.baseline.quote_unit_price) : null;
              const cur = form.unit_price !== '' && form.unit_price != null ? Number(form.unit_price) : null;
              const over = budPrice != null && budPrice > 0 && cur != null && cur > budPrice;
              const overPct = over ? Math.round((cur! - budPrice) / budPrice * 1000) / 10 : null;
              const within = budPrice != null && budPrice > 0 && cur != null && cur <= budPrice;
              return (
                <label className="text-gray-600">单价
                  <input type="number" value={form.unit_price ?? ''} onChange={e => set('unit_price', e.target.value)}
                    className={`mt-1 w-full rounded border px-2 py-1.5 ${over ? 'border-rose-400 bg-rose-50 text-rose-700 font-semibold' : 'border-gray-300'}`} />
                  {budPrice != null && budPrice > 0
                    ? <span className="block mt-0.5 text-[10px]">
                        <span className="text-indigo-500">预算(报价)单价 ¥{budPrice}</span>
                        {over && <span className="text-rose-600 font-medium"> · 🔴 超预算 +{overPct}%(需财务审批)</span>}
                        {within && <span className="text-emerald-600"> · 🟢 在预算内</span>}
                      </span>
                    : <span className="block mt-0.5 text-[10px] text-gray-300">报价基线未冻结,无预算可比</span>}
                </label>
              );
            })()}
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
      {dialog}
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
