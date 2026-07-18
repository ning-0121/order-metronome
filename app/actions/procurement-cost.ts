'use server';

/**
 * 采购成本核算（P4 A+C）—— 派生视图 + 显式回填。
 * 成本/金额受 CAN_SEE_PROCUREMENT_FLOOR（采购/采购经理/财务/admin）；业务不看。
 * 回填 actual_material_cost 只在人工点回填时写（标来源=采购），避免与成本表双源。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { deriveOrderQuantityContext, quantityForBasis } from '@/lib/domain/quantity-engine';
import { computeProcurementCostSummary, computeReceivingDiff } from '@/lib/services/procurement-cost';
import { calculateProfitSnapshot } from '@/lib/services/profit.service';

async function authFloor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, canFloor: false };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, canFloor: hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR') };
}

/** 有采购行的订单列表（成本核算入口索引）。 */
export async function listOrdersWithProcurement(limit = 50): Promise<{ data?: any[]; error?: string }> {
  const { supabase, userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权查看采购成本' };
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('order_id').order('created_at', { ascending: false });
  const orderIds = [...new Set((lines || []).map((l: any) => l.order_id).filter(Boolean))].slice(0, limit);
  if (orderIds.length === 0) return { data: [] };
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, lifecycle_status').in('id', orderIds);
  // 隐藏已取消/已归档订单(2026-07-05 用户拍板:成本核算不列废单)
  const HIDDEN = ['cancelled', '已取消', 'archived', '已归档'];
  return { data: (orders || []).filter((o: any) => !HIDDEN.includes(o.lifecycle_status)) };
}

/** 采购成本核算 + 订收差异（派生，只读）。 */
export async function getProcurementCostSummary(orderId: string): Promise<{ data?: any; error?: string }> {
  const { supabase, userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权查看采购成本' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };

  // 价列已列级封锁,floor 角色经 service-role 读(本函数已 canFloor 门禁)
  const { data: lines } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('material_name, category, ordered_unit, ordered_qty, received_qty, unit_price, ordered_amount')
    .eq('order_id', orderId);

  const { data: fin } = await (supabase.from('order_financials') as any)
    .select('budgeted_material_cost, actual_material_cost').eq('order_id', orderId).maybeSingle();

  const budget = (fin as any)?.budgeted_material_cost != null ? Number((fin as any).budgeted_material_cost) : null;
  const summary = computeProcurementCostSummary((lines || []) as any[], budget);
  const receivingDiff = computeReceivingDiff((lines || []) as any[]);

  return {
    data: {
      order,
      summary,
      receivingDiff,
      current_actual_material_cost: (fin as any)?.actual_material_cost ?? null,
    },
  };
}

/**
 * 预算 vs 实际 四列对照(2026-07-05 用户拍板):逐物料 预算/实际下单/实际送货/尾料剩余,
 * 每列 数量·单价·总额;实际下单哪项超预算标红。预算来自报价基线(单件用量×订单件数)。
 */
export async function getBudgetVsActual(orderId: string): Promise<{ data?: any; error?: string }> {
  const { userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权查看采购成本' };
  const svc = createServiceRoleClient();

  const { data: order } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, quantity, quantity_unit').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  const orderQty = Number((order as any).quantity) || 0;
  const orderQtyCtx = deriveOrderQuantityContext({
    physicalQuantity: (order as any).quantity ?? null,
    quantityUnit: (order as any).quantity_unit ?? null,
  });

  // 2026-07-08 弃用报价基线:面料预算改从 materials_bom(采购核料业务填 大货单耗×预算单价,真实物料名 →
  //   与实际下单同名对齐,不再"仿锦 vs 280g直贡呢"对不上);辅料/加工按款存 quote_style_budgets(采购核料填)。
  const { data: base } = await (svc.from('order_cost_baseline') as any)
    .select('*').eq('order_id', orderId).maybeSingle();   // * → accessory_budget_total 列未建也不报错
  const styleBudgets: any[] = (base as any)?.quote_style_budgets || [];   // 逐款加工费 cmt(元/件)源
  const { data: bomRows } = await (svc.from('materials_bom') as any)
    .select('material_name, color, material_type, production_consumption, budget_unit_price, style_no, unit').eq('order_id', orderId);

  const { data: lines } = await (svc.from('procurement_line_items') as any)
    .select('material_name, category, ordered_qty, received_qty, unit_price, ordered_amount, ordered_unit, procurement_item_id').eq('order_id', orderId);

  // 逐款/款色件数(order_line_items):辅料预算=Σ(款辅料总价,一口价不按件数);面料预算件数=按款色/款/整单
  const { data: liQ } = await (svc.from('order_line_items') as any).select('style_no, color_cn, color_en, qty_pcs').eq('order_id', orderId);
  const nrm = (s: any) => String(s ?? '').trim().toLowerCase();
  const qtyByStyle = new Map<string, number>(); const qtyByStyleColor = new Map<string, number>();
  for (const li of (liQ || [])) {
    const st = nrm((li as any).style_no); const q = Number((li as any).qty_pcs) || 0;
    qtyByStyle.set(st, (qtyByStyle.get(st) || 0) + q);
    for (const col of [(li as any).color_cn, (li as any).color_en]) if (col) qtyByStyleColor.set(`${st}¦${nrm(col)}`, q);
  }
  const piecesForBom = (b: any): number => {
    const st = nrm(b.style_no);
    if (b.style_no && b.color) {
      const v = qtyByStyleColor.get(`${st}¦${nrm(b.color)}`);
      if (v != null) {
        return quantityForBasis(
          deriveOrderQuantityContext({
            physicalQuantity: v,
            quantityUnit: (order as any).quantity_unit ?? null,
          }),
          b.consumption_basis || 'PER_SET',
        ) || v;
      }
    }
    if (b.style_no) {
      const v = qtyByStyle.get(st);
      if (v) {
        return quantityForBasis(
          deriveOrderQuantityContext({
            physicalQuantity: v,
            quantityUnit: (order as any).quantity_unit ?? null,
          }),
          b.consumption_basis || 'PER_SET',
        ) || v;
      }
    }
    return quantityForBasis(orderQtyCtx, b.consumption_basis || 'PER_SET') || orderQty;
  };
  // 辅料预算 = 整单一口价 order_cost_baseline.accessory_budget_total(不按件数;2026-07-08 用户拍板)
  const trimBudgetTotal = Math.round((Number((base as any)?.accessory_budget_total) || 0) * 100) / 100;
  const hasTrimBudget = trimBudgetTotal > 0;
  // 加工费预算 = Σ(该款加工费 × 该款件数)。采购不下单加工费,此为预算参考行(实际列留空;2026-07-08 用户:加工费也要跟到采购)
  let cmtBudgetTotal = 0; let hasCmtBudget = false;
  for (const sb of styleBudgets) {
    const c = Number((sb as any).cmt); if (!(c > 0)) continue;
    const st = nrm((sb as any).style_no);
    const q = quantityForBasis(
      deriveOrderQuantityContext({
        physicalQuantity: qtyByStyle.get(st) || (styleBudgets.length === 1 ? orderQty : 0),
        quantityUnit: (order as any).quantity_unit ?? null,
      }),
      (sb as any).cmt_basis || 'PER_SET',
    ) || 0;
    if (q > 0) { cmtBudgetTotal += c * q; hasCmtBudget = true; }
  }
  cmtBudgetTotal = Math.round(cmtBudgetTotal * 100) / 100;

  const { getOrderLeftover } = await import('@/app/actions/inventory');
  const leftoverRows: any[] = ((await getOrderLeftover(orderId)) as any).data || [];

  // 颜色回查(2026-07-06 用户:成本核算看不出颜色、给的是均价)——执行行经 procurement_item_id、
  // 尾料经 material_key(=consolidation_key)回查 procurement_items.color,按 料+色 逐行核算,不再合并均价。
  const piIds = [...new Set((lines || []).map((l: any) => l.procurement_item_id).filter(Boolean))];
  const colorByPi = new Map<string, string | null>();
  if (piIds.length) {
    const { data: pis } = await (svc.from('procurement_items') as any).select('id, color').in('id', piIds);
    for (const p of (pis || [])) colorByPi.set((p as any).id, (p as any).color ?? null);
  }
  const lkKeys = [...new Set(leftoverRows.map((r: any) => r.material_key).filter(Boolean))];
  const colorByKey = new Map<string, string | null>();
  if (lkKeys.length) {
    const { data: pisk } = await (svc.from('procurement_items') as any).select('consolidation_key, color').in('consolidation_key', lkKeys);
    for (const p of (pisk || [])) { const k = (p as any).consolidation_key; if (k && !colorByKey.has(k)) colorByKey.set(k, (p as any).color ?? null); }
  }

  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const ckey = (name: any, color: any) => `${norm(name)}¦${norm(color)}`;

  // 预算:面料逐料从 materials_bom 汇总(大货单耗×预算单价×件数);真实物料名 → 与实际下单同名对齐
  const budgetMap = new Map<string, { name: string; unit: string | null; consumption: number; price: number; qty: number; amount: number }>();
  for (const b of (bomRows || [])) {
    if ((b as any).material_type !== 'fabric' && (b as any).material_type !== 'lining') continue;
    const k = norm((b as any).material_name); if (!k) continue;
    const cons = Number((b as any).production_consumption) || 0;
    const price = Number((b as any).budget_unit_price) || 0;
    const pcs = piecesForBom(b);
    const ex = budgetMap.get(k) || { name: (b as any).material_name, unit: (b as any).unit || null, consumption: cons, price, qty: 0, amount: 0 };
    ex.qty += cons * pcs;
    ex.amount += cons * price * pcs;
    if (price) ex.price = price;
    if (cons) ex.consumption = cons;
    budgetMap.set(k, ex);
  }
  // 实际(下单/送货)按 料+色 聚合(同色的行才合并 → 单价是该色真实价,不是跨色均价)
  // 顺带记哪些料是布料(category=fabric / 在报价基线里);辅料(其余)要合并成一行总额
  const fabricMats = new Set<string>([...budgetMap.keys()]);
  const actualMap = new Map<string, { name: string; color: string | null; mat: string; unit: string | null; oQty: number; oAmt: number; rQty: number; pSum: number; pN: number }>();
  for (const l of (lines || [])) {
    if (!norm(l.material_name)) continue;
    if (norm(l.category) === 'fabric') fabricMats.add(norm(l.material_name));
    const color = l.procurement_item_id ? (colorByPi.get(l.procurement_item_id) ?? null) : null;
    const k = ckey(l.material_name, color);
    const a = actualMap.get(k) || { name: l.material_name, color, mat: norm(l.material_name), unit: l.ordered_unit || null, oQty: 0, oAmt: 0, rQty: 0, pSum: 0, pN: 0 };
    a.oQty += Number(l.ordered_qty) || 0; a.oAmt += Number(l.ordered_amount) || 0; a.rQty += Number(l.received_qty) || 0;
    if (l.unit_price != null) { a.pSum += Number(l.unit_price); a.pN++; }
    actualMap.set(k, a);
  }
  // 尾料 按 料+色
  const leftoverMap = new Map<string, { qty: number; name: string; color: string | null; mat: string }>();
  for (const r of leftoverRows) {
    if (!norm(r.material_name)) continue;
    const color = r.material_key ? (colorByKey.get(r.material_key) ?? null) : null;
    const k = ckey(r.material_name, color);
    const ex = leftoverMap.get(k) || { qty: 0, name: r.material_name, color, mat: norm(r.material_name) };
    ex.qty += Number(r.leftover) || 0; leftoverMap.set(k, ex);
  }

  // 行 = 实际∪尾料 的所有"料+色";再补上"有预算但完全没采购"的料(按料无色成行)
  const colorKeys = new Set<string>([...actualMap.keys(), ...leftoverMap.keys()]);
  const matsWithRows = new Set<string>([...colorKeys].map((k) => k.split('¦')[0]));
  for (const bm of budgetMap.keys()) { if (!matsWithRows.has(bm)) colorKeys.add(`${bm}¦`); }

  const isFabricKey = (k: string) => fabricMats.has(k.split('¦')[0]);
  const budgetGiven = new Set<string>();   // 每料预算只挂到它的第一行,避免总额被色数放大
  // 布料:逐料+色成行(分类型·同色加总,报价基线对照);辅料:全部并成「辅料合计」一行(2026-07-07 用户拍板)
  const fabricRows = [...colorKeys].filter(isFabricKey).map((k) => {
    const a = actualMap.get(k); const lo = leftoverMap.get(k);
    const mat = k.split('¦')[0];
    const b = budgetMap.get(mat);
    const giveBudget = !!b && !budgetGiven.has(mat);
    if (giveBudget) budgetGiven.add(mat);
    const budQty = giveBudget && b!.qty > 0 ? r3(b!.qty) : null;
    const budPrice = giveBudget ? (b!.price || null) : null;
    const budTotal = giveBudget && b!.amount > 0 ? r2(b!.amount) : null;
    const oQty = a ? r3(a.oQty) : 0;
    const oPrice = a && a.pN ? Math.round(a.pSum / a.pN * 10000) / 10000 : null;
    const oTotal = a ? r2(a.oAmt) : 0;
    const rQty = a ? r3(a.rQty) : 0;
    const rTotal = oPrice != null ? r2(rQty * oPrice) : null;
    const lQty = lo ? r3(lo.qty) : 0;
    const lTotal = oPrice != null ? r2(lQty * oPrice) : null;
    return {
      material_name: a?.name || lo?.name || b?.name || mat,
      color: a?.color ?? lo?.color ?? null,
      unit: a?.unit || b?.unit || null,
      budget: { qty: budQty, price: budPrice, total: budTotal },
      ordered: {
        qty: oQty, price: oPrice, total: oTotal,
        over_qty: budQty != null && oQty > budQty,
        over_price: budPrice != null && oPrice != null && oPrice > budPrice,
        over_total: budTotal != null && oTotal > budTotal,
      },
      received: { qty: rQty, total: rTotal },
      leftover: { qty: lQty, total: lTotal },
    };
  }).sort((x, y) => (y.ordered.total || 0) - (x.ordered.total || 0));

  // 辅料合计一行:辅料预算(Σ 款辅料总价,一口价)vs 下单总额(比总额,不分细类)。混单位 → 只比总额,不显数量。
  const trimKeys = [...colorKeys].filter((k) => !isFabricKey(k));
  let toAmt = 0;
  for (const k of trimKeys) { const a = actualMap.get(k); if (a) toAmt += a.oAmt; }
  toAmt = r2(toAmt);
  const trimRows = (trimKeys.length > 0 || hasTrimBudget) ? [{
    material_name: '辅料合计', color: null, unit: '—',
    budget: { qty: null, price: null, total: hasTrimBudget ? trimBudgetTotal : null },
    ordered: { qty: null, price: null, total: toAmt, over_qty: false, over_price: false,
      over_total: hasTrimBudget && trimBudgetTotal > 0 && toAmt > trimBudgetTotal },
    received: { qty: null, total: null }, leftover: { qty: null, total: null }, is_trim_total: true,
  }] : [];

  // 加工费一行(预算参考;采购不下单加工费 → 实际列空)。让业务填的加工费也在采购核算看得到(2026-07-08 用户)
  const cmtRows = hasCmtBudget ? [{
    material_name: '加工费', color: null, unit: '—',
    budget: { qty: null, price: null, total: cmtBudgetTotal },
    ordered: { qty: null, price: null, total: null, over_qty: false, over_price: false, over_total: false },
    received: { qty: null, total: null }, leftover: { qty: null, total: null }, is_cmt_total: true,
  }] : [];

  const rows = [...fabricRows, ...trimRows, ...cmtRows];

  const totals = rows.reduce((t, r) => ({
    budget: r2(t.budget + (r.budget.total || 0)), ordered: r2(t.ordered + (r.ordered.total || 0)),
    received: r2(t.received + (r.received.total || 0)), leftover: r2(t.leftover + (r.leftover.total || 0)),
  }), { budget: 0, ordered: 0, received: 0, leftover: 0 });

  return { data: { order, rows, totals, orderQty, has_budget: budgetMap.size > 0 || hasTrimBudget || hasCmtBudget } };
}

/** 辅料 预算 vs 实际(2026-07-08 用户拍板 A):实际=采购填的单价×采购数量(填了即算)。仅底价可见角色。 */
export async function getAccessoryCostSummary(orderId: string): Promise<{ data?: { budget: number | null; actual: number; over: number | null; itemsPriced: number; itemsTotal: number }; error?: string }> {
  const { userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权查看采购成本' };
  const svc = createServiceRoleClient();
  const { data: items } = await (svc.from('procurement_items') as any)
    .select('category, unit_price, final_purchase_qty, suggested_purchase_qty, total_required_qty, stock_deduct_qty')
    .eq('order_id', orderId);
  const trims = (items || []).filter((it: any) => {
    const c = String(it.category ?? '').trim().toLowerCase();
    return c !== 'fabric' && c !== 'lining' && c !== '面料' && c !== '里料';
  });
  const { computeActualAccessoryTotal } = await import('@/lib/services/procurement-cost');
  const actual = computeActualAccessoryTotal(trims as any);
  const itemsPriced = trims.filter((it: any) => Number(it.unit_price) > 0).length;
  const { data: base } = await (svc.from('order_cost_baseline') as any)
    .select('accessory_budget_total').eq('order_id', orderId).maybeSingle();
  const budget = (base as any)?.accessory_budget_total != null ? Number((base as any).accessory_budget_total) : null;
  const over = budget != null ? Math.round((actual - budget) * 100) / 100 : null;
  return { data: { budget, actual, over, itemsPriced, itemsTotal: trims.length } };
}

/** 显式回填：以采购实际成本写 order_financials.actual_material_cost + 重算利润（人工触发）。 */
export async function backfillActualMaterialCost(orderId: string): Promise<{ error?: string; ok?: boolean; actual?: number }> {
  const { supabase, userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权回填采购成本' };

  // 价列已列级封锁,floor 角色经 service-role 读(本函数已 canFloor 门禁)
  const { data: lines } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('ordered_qty, received_qty, unit_price, ordered_amount').eq('order_id', orderId);
  const summary = computeProcurementCostSummary((lines || []) as any[], null);

  // upsert order_financials.actual_material_cost（该字段现由成本表也能填 → 此为人工选"用采购实际"）
  const { data: existing } = await (supabase.from('order_financials') as any)
    .select('id').eq('order_id', orderId).maybeSingle();
  if (existing) {
    const { error } = await (supabase.from('order_financials') as any)
      .update({ actual_material_cost: summary.actual_cost, updated_at: new Date().toISOString() }).eq('order_id', orderId);
    if (error) return { error: error.message };
  } else {
    const { error } = await (supabase.from('order_financials') as any)
      .insert({ order_id: orderId, actual_material_cost: summary.actual_cost });
    if (error) return { error: error.message };
  }

  // 重算利润快照（复用现有 profit.service，与 cost-control 同口径）
  try { await calculateProfitSnapshot(supabase, { orderId, snapshotType: 'live' }); } catch { /* 利润重算失败不阻断回填 */ }

  revalidatePath(`/procurement/cost/${orderId}`);
  return { ok: true, actual: summary.actual_cost };
}
