'use server';

/**
 * 供应商采购对账台账(面料账目导入,2026-07-11)。
 * 用途:采购自己的对账台账;导入《面料采购明细表汇总》(每 sheet=一供应商)。
 * 归属:采购对账 → 节拍器(本表);付款/推财务将来按【供应商 + 内部订单号 + 金额(不含税)】对接。
 * 权限:采购/采购经理/管理员可导入(RLS 读 + action 写门禁 + service-role 落库)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { parseFabricLedger, type FabricLedgerRow } from '@/lib/services/fabric-ledger-parser';

const WRITE_MSG = '仅采购/采购经理/管理员可导入供应商账目';
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ImportResult {
  ok: boolean;
  error?: string;
  batchId?: string;
  rowCount?: number;
  sheetCount?: number;
  totalAmount?: number;
  matchedSupplier?: number;   // 匹配到供应商主数据的行数
  matchedOrder?: number;      // 匹配到系统订单的行数
  unmatchedSupplier?: number;
  unmatchedOrder?: number;
  warnings?: string[];
}

/** 导入一个《面料采购明细表汇总》工作簿。 */
export async function importSupplierLedger(formData: FormData): Promise<ImportResult> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };

    const file = formData.get('file') as File | null;
    if (!file) return { ok: false, error: '未收到文件' };
    const buffer = Buffer.from(await file.arrayBuffer());

    const parsed = parseFabricLedger(buffer);
    if (!parsed.rows.length) {
      return { ok: false, error: '未解析出任何明细行(检查是否是《面料采购明细表汇总》格式)', warnings: parsed.warnings };
    }

    const svc = createServiceRoleClient();

    // --- 匹配供应商主数据(按 name,忽略前后空格,精确优先)---
    const supplierNames = [...new Set(parsed.rows.map((r) => r.supplierNameRaw))];
    const { data: suppliers } = await (svc.from('suppliers') as any)
      .select('id, name').in('name', supplierNames);
    const supMap = new Map<string, string>();
    for (const s of (suppliers || [])) supMap.set(String(s.name).trim(), s.id);

    // --- 匹配系统订单(按 internal_order_no)---
    const internalNos = [...new Set(parsed.rows.map((r) => r.internalOrderNo).filter(Boolean))] as string[];
    const orderMap = new Map<string, string>();
    if (internalNos.length) {
      const { data: orders } = await (svc.from('orders') as any)
        .select('id, internal_order_no').in('internal_order_no', internalNos);
      for (const o of (orders || [])) {
        if (o.internal_order_no) orderMap.set(String(o.internal_order_no), o.id);
      }
    }

    // --- 建批次 ---
    const totalAmount = round2(parsed.totalAmount);
    const { data: batch, error: batchErr } = await (svc.from('supplier_ledger_imports') as any)
      .insert({
        file_name: file.name || '面料采购明细表汇总.xlsx',
        sheet_count: parsed.sheetCount,
        row_count: parsed.rows.length,
        total_amount_ex_tax: totalAmount,
        imported_by: user.id,
      }).select('id').single();
    if (batchErr || !batch) return { ok: false, error: friendlyError(batchErr) || '建导入批次失败' };

    // --- 落明细 ---
    let matchedSupplier = 0, matchedOrder = 0;
    const nowIso = new Date().toISOString();
    const rowsToInsert = parsed.rows.map((r: FabricLedgerRow) => {
      const supplier_id = supMap.get(r.supplierNameRaw.trim()) || null;
      const order_id = r.internalOrderNo ? (orderMap.get(r.internalOrderNo) || null) : null;
      if (supplier_id) matchedSupplier += 1;
      if (order_id) matchedOrder += 1;
      return {
        supplier_name_raw: r.supplierNameRaw,
        supplier_id,
        order_no_raw: r.orderNoRaw || null,
        internal_order_no: r.internalOrderNo,
        order_id,
        fabric_name: r.fabricName || null,
        color: r.color || null,
        ordered_kg: r.orderedKg,
        received_kg: r.receivedKg,
        diff_kg: r.diffKg,
        unit_price_ex_tax: r.unitPriceExTax,
        amount_ex_tax: r.amountExTax,
        invoice_status: r.invoiceStatus || null,
        delivery_note: r.deliveryNote || null,
        customer_name: r.customerName || null,
        import_batch_id: batch.id,
        source: 'import',
        created_by: user.id,
        created_at: nowIso,
        updated_at: nowIso,
      };
    });

    // 分批插入(每 500 行),避免单次过大
    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
      const { error: insErr } = await (svc.from('supplier_fabric_ledger') as any).insert(chunk);
      if (insErr) return { ok: false, error: friendlyError(insErr) || '写入台账失败' };
    }

    revalidatePath('/procurement/ledger');
    return {
      ok: true,
      batchId: batch.id,
      rowCount: parsed.rows.length,
      sheetCount: parsed.sheetCount,
      totalAmount,
      matchedSupplier,
      matchedOrder,
      unmatchedSupplier: parsed.rows.length - matchedSupplier,
      unmatchedOrder: parsed.rows.length - matchedOrder,
      warnings: parsed.warnings,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || '导入失败' };
  }
}

export interface LedgerLine {
  id: string;
  supplier_name_raw: string;
  supplier_id: string | null;
  order_no_raw: string | null;
  internal_order_no: string | null;
  order_id: string | null;
  fabric_name: string | null;
  color: string | null;
  ordered_kg: number | null;
  received_kg: number | null;
  diff_kg: number | null;
  unit_price_ex_tax: number | null;
  amount_ex_tax: number | null;
  tax_rate: number | null;
  amount_incl_tax: number | null;
  invoice_status: string | null;
  delivery_note: string | null;
  customer_name: string | null;
  payable_bill_no: string | null;
  payable_pushed_at: string | null;
  created_at: string;
}

export interface OrderGroup {
  order_no_raw: string;             // 分组键(展示的订单号;空→'(未标订单)')
  internal_order_no: string | null;
  order_id: string | null;
  lineCount: number;
  amountExTax: number;
  amountInclTax: number;
  taxRate: number | null;           // 组内统一税率;混合/未设→null
  pushed: boolean;                  // 已推财务
  payableBillNo: string | null;
  lines: LedgerLine[];
}

export interface SupplierGroup {
  supplier_name_raw: string;
  supplier_id: string | null;
  matched: boolean;                 // 是否已关联供应商主数据
  lineCount: number;
  totalExTax: number;
  totalInclTax: number;
  unbilledCount: number;            // 「没见票」等未见票行数
  orders: OrderGroup[];
}

const ORDER_KEY = (l: LedgerLine) => (l.order_no_raw || '(未标订单)');

/** 读台账:供应商 → 订单 → 明细行(推财务按订单粒度)。 */
export async function getSupplierLedger(): Promise<{ groups: SupplierGroup[]; grandTotalExTax: number; grandTotalInclTax: number }> {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('supplier_fabric_ledger') as any)
    .select('*')
    .order('supplier_name_raw', { ascending: true })
    .order('order_no_raw', { ascending: true })
    .order('created_at', { ascending: true });
  if (error || !data) return { groups: [], grandTotalExTax: 0, grandTotalInclTax: 0 };

  const sup = new Map<string, SupplierGroup>();
  const ordMap = new Map<string, OrderGroup>();       // key = supplier|order
  let grandEx = 0, grandIncl = 0;

  for (const l of data as LedgerLine[]) {
    const sKey = l.supplier_name_raw;
    if (!sup.has(sKey)) {
      sup.set(sKey, {
        supplier_name_raw: l.supplier_name_raw, supplier_id: l.supplier_id,
        matched: !!l.supplier_id, lineCount: 0, totalExTax: 0, totalInclTax: 0,
        unbilledCount: 0, orders: [],
      });
    }
    const sg = sup.get(sKey)!;
    const oKey = `${sKey}|${ORDER_KEY(l)}`;
    if (!ordMap.has(oKey)) {
      const og: OrderGroup = {
        order_no_raw: ORDER_KEY(l), internal_order_no: l.internal_order_no, order_id: l.order_id,
        lineCount: 0, amountExTax: 0, amountInclTax: 0, taxRate: undefined as any,
        pushed: false, payableBillNo: null, lines: [],
      };
      ordMap.set(oKey, og);
      sg.orders.push(og);
    }
    const og = ordMap.get(oKey)!;
    const ex = Number(l.amount_ex_tax) || 0;
    const incl = Number(l.amount_incl_tax) || 0;
    og.lines.push(l); og.lineCount += 1; og.amountExTax += ex; og.amountInclTax += incl;
    // 组内统一税率判定
    if (og.taxRate === (undefined as any)) og.taxRate = l.tax_rate ?? null;
    else if (og.taxRate !== (l.tax_rate ?? null)) og.taxRate = null;
    if (l.payable_pushed_at) { og.pushed = true; og.payableBillNo = l.payable_bill_no; }

    sg.lineCount += 1; sg.totalExTax += ex; sg.totalInclTax += incl;
    grandEx += ex; grandIncl += incl;
    if (l.invoice_status && /没见票|未见票|未收票|无票/.test(l.invoice_status)) sg.unbilledCount += 1;
  }

  const groups = [...sup.values()].map((g) => ({
    ...g, totalExTax: round2(g.totalExTax), totalInclTax: round2(g.totalInclTax),
    orders: g.orders.map((o) => ({
      ...o, amountExTax: round2(o.amountExTax), amountInclTax: round2(o.amountInclTax),
      taxRate: (o.taxRate === (undefined as any) ? null : o.taxRate),
    })),
  })).sort((a, b) => b.totalExTax - a.totalExTax);
  return { groups, grandTotalExTax: round2(grandEx), grandTotalInclTax: round2(grandIncl) };
}

// ============================================================
// Part1:设税率(单价存不含税 → 设税率算含税)
// ============================================================
/** 给某供应商所有(未推财务的)行设税率;rate 传小数(0.13);清空传 null。 */
export async function setLedgerTaxRate(params: { supplierNameRaw: string; rate: number | null }): Promise<{ ok: boolean; error?: string; updated?: number }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };
    const rate = params.rate == null ? null : Number(params.rate);
    if (rate != null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) return { ok: false, error: '税率应是 0~1 的小数(13% 填 0.13)' };

    const svc = createServiceRoleClient();
    const { data, error } = await (svc.from('supplier_fabric_ledger') as any)
      .update({ tax_rate: rate, updated_at: new Date().toISOString() })
      .eq('supplier_name_raw', params.supplierNameRaw)
      .is('payable_pushed_at', null)
      .select('id');
    if (error) return { ok: false, error: friendlyError(error) };
    revalidatePath('/procurement/ledger');
    return { ok: true, updated: (data || []).length };
  } catch (e: any) { return { ok: false, error: e?.message || '设置失败' }; }
}

// ============================================================
// Part2:手动关联供应商 / 订单
// ============================================================
/** 把某供应商名(sheet 名)下所有行关联到供应商主数据。 */
export async function linkLedgerSupplier(supplierNameRaw: string, supplierId: string): Promise<{ ok: boolean; error?: string; updated?: number }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };
    const svc = createServiceRoleClient();
    const { data, error } = await (svc.from('supplier_fabric_ledger') as any)
      .update({ supplier_id: supplierId, updated_at: new Date().toISOString() })
      .eq('supplier_name_raw', supplierNameRaw).select('id');
    if (error) return { ok: false, error: friendlyError(error) };
    revalidatePath('/procurement/ledger');
    return { ok: true, updated: (data || []).length };
  } catch (e: any) { return { ok: false, error: e?.message || '关联失败' }; }
}

/** 把某供应商下某订单号(order_no_raw)的所有行关联到系统订单。 */
export async function linkLedgerOrder(params: { supplierNameRaw: string; orderNoRaw: string; orderId: string }): Promise<{ ok: boolean; error?: string; updated?: number }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };
    const svc = createServiceRoleClient();
    const { data: order } = await (svc.from('orders') as any)
      .select('id, internal_order_no').eq('id', params.orderId).maybeSingle();
    if (!order) return { ok: false, error: '订单不存在' };
    const { data, error } = await (svc.from('supplier_fabric_ledger') as any)
      .update({ order_id: params.orderId, internal_order_no: (order as any).internal_order_no || null, updated_at: new Date().toISOString() })
      .eq('supplier_name_raw', params.supplierNameRaw).eq('order_no_raw', params.orderNoRaw)
      .is('payable_pushed_at', null).select('id');
    if (error) return { ok: false, error: friendlyError(error) };
    revalidatePath('/procurement/ledger');
    return { ok: true, updated: (data || []).length };
  } catch (e: any) { return { ok: false, error: e?.message || '关联失败' }; }
}

/** 搜订单(给关联下拉;按内部单号/客户/款号 ilike)。 */
export async function searchOrdersForLink(q: string): Promise<{ id: string; label: string }[]> {
  const supabase = await createClient();
  const term = (q || '').trim();
  let query = (supabase.from('orders') as any)
    .select('id, internal_order_no, customer_name, style_no, order_no')
    .order('created_at', { ascending: false }).limit(20);
  if (term) query = query.or(`internal_order_no.ilike.%${term}%,customer_name.ilike.%${term}%,style_no.ilike.%${term}%,order_no.ilike.%${term}%`);
  const { data } = await query;
  return ((data || []) as any[]).map((o) => ({
    id: o.id,
    label: [o.internal_order_no || o.order_no, o.customer_name, o.style_no].filter(Boolean).join(' · '),
  }));
}

// ============================================================
// Part3:一键推财务建应付(按供应商 × 订单)
// ============================================================
export async function pushLedgerGroupToFinance(params: { supplierNameRaw: string; orderNoRaw: string }): Promise<{ ok: boolean; error?: string; billNo?: string; amount?: number }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };

    const svc = createServiceRoleClient();
    // '(未标订单)' 组:order_no_raw 实为 null
    const isUnlabeled = params.orderNoRaw === '(未标订单)';
    let sel = (svc.from('supplier_fabric_ledger') as any)
      .select('id, supplier_id, supplier_name_raw, internal_order_no, order_id, order_no_raw, fabric_name, color, ordered_kg, received_kg, unit_price_ex_tax, amount_ex_tax, tax_rate, amount_incl_tax, payable_pushed_at')
      .eq('supplier_name_raw', params.supplierNameRaw);
    sel = isUnlabeled ? sel.is('order_no_raw', null) : sel.eq('order_no_raw', params.orderNoRaw);
    const { data: rows } = await sel;
    const lines = (rows || []) as any[];
    if (!lines.length) return { ok: false, error: '该组没有明细行' };
    if (lines.some((l) => l.payable_pushed_at)) return { ok: false, error: '该组已推过财务,不重复推' };

    const supplierId = lines.find((l) => l.supplier_id)?.supplier_id || null;
    if (!supplierId) return { ok: false, error: '请先关联供应商主数据,再推财务' };
    // 取供应商正式名
    const { data: sup } = await (svc.from('suppliers') as any).select('name').eq('id', supplierId).maybeSingle();
    const supplierName = (sup as any)?.name || params.supplierNameRaw;

    const amountExTax = round2(lines.reduce((s, l) => s + (Number(l.amount_ex_tax) || 0), 0));
    const amountInclTax = round2(lines.reduce((s, l) => s + (Number(l.amount_incl_tax) || 0), 0));
    if (amountInclTax <= 0) return { ok: false, error: '金额为 0,无法推财务' };
    const rateSet = new Set(lines.map((l) => (l.tax_rate == null ? 'null' : String(l.tax_rate))));
    const taxRate = rateSet.size === 1 && !rateSet.has('null') ? Number([...rateSet][0]) : null;
    const internalNo = lines.find((l) => l.internal_order_no)?.internal_order_no || null;
    const orderId = lines.find((l) => l.order_id)?.order_id || null;

    // 单号 LG-YYYYMMDD-NNN
    const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { count } = await (svc.from('supplier_ledger_payables') as any).select('id', { count: 'exact', head: true });
    const billNo = `LG-${dateTag}-${String((count || 0) + 1).padStart(3, '0')}`;

    const { data: payable, error: pErr } = await (svc.from('supplier_ledger_payables') as any).insert({
      bill_no: billNo, supplier_id: supplierId, supplier_name: supplierName,
      order_no_raw: isUnlabeled ? null : params.orderNoRaw, internal_order_no: internalNo, order_id: orderId,
      line_count: lines.length, amount_ex_tax: amountExTax, tax_rate: taxRate, amount_incl_tax: amountInclTax,
      currency: 'CNY', status: 'submitted', pushed_by: user.id,
    }).select('id, bill_no').single();
    if (pErr || !payable) return { ok: false, error: friendlyError(pErr) || '建付款申请失败' };

    // 回写行状态(防重推)
    await (svc.from('supplier_fabric_ledger') as any)
      .update({ payable_id: (payable as any).id, payable_bill_no: billNo, payable_pushed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in('id', lines.map((l) => l.id));

    // emit payable.created(fire-and-forget;失败落 outbox,不阻断)
    try {
      const { emitProcurementPayableToFinance, fetchOrderRefs } = await import('@/lib/integration/finance-sync');
      let orderRefs: unknown[] = [];
      if (orderId) { try { orderRefs = (await fetchOrderRefs([orderId])) as unknown[]; } catch { /* ignore */ } }
      const financeLines = lines.map((l) => ({
        material_name: l.fabric_name ?? null,
        specification: l.color ?? null,
        ordered_qty: Number(l.ordered_kg) || 0,
        unit_price: Number(l.unit_price_ex_tax) || 0,
        po_amount: round2(Number(l.amount_ex_tax) || 0),   // 不含税金额
        received_qty: Number(l.received_kg) || 0,
        supplier_amount: round2(Number(l.amount_ex_tax) || 0),
        net_amount: round2(Number(l.amount_incl_tax) || 0), // 含税(推给财务的口径)
      }));
      await emitProcurementPayableToFinance({
        source_ref: (payable as any).id, bill_no: billNo,
        supplier_name: supplierName, supplier_id: supplierId,
        amount: amountInclTax, currency: 'CNY',
        description: `面料台账应付 · ${supplierName} · ${isUnlabeled ? '未标订单' : params.orderNoRaw}${taxRate != null ? ` · 税率${Math.round(taxRate * 100)}%` : ' · 不含税'}`,
        reconciliation_id: null, purchase_order_id: null, po_no: null,
        order_refs: orderRefs, due_date: null, lines: financeLines,
      });
    } catch (e: any) { console.warn('[pushLedgerGroupToFinance] emit payable.created 失败(不阻断):', e?.message); }

    revalidatePath('/procurement/ledger');
    return { ok: true, billNo, amount: amountInclTax };
  } catch (e: any) { return { ok: false, error: e?.message || '推财务失败' }; }
}

// ============================================================
// 导入记录:查看批次 / 删除重传(表格传错时删掉整批重来)
// ============================================================
export interface LedgerImportBatch {
  id: string;
  file_name: string | null;
  sheet_count: number;
  row_count: number;
  total_amount_ex_tax: number;
  created_at: string;
  pushed_count: number;   // 该批已推财务的行数(>0 则禁删)
}

/** 列出导入批次(最近在前),带该批已推财务的行数。 */
export async function getLedgerImports(): Promise<LedgerImportBatch[]> {
  const supabase = await createClient();
  const { data: imports } = await (supabase.from('supplier_ledger_imports') as any)
    .select('id, file_name, sheet_count, row_count, total_amount_ex_tax, created_at')
    .order('created_at', { ascending: false });
  if (!imports || !imports.length) return [];
  // 每批已推财务行数
  const { data: pushed } = await (supabase.from('supplier_fabric_ledger') as any)
    .select('import_batch_id').not('payable_pushed_at', 'is', null);
  const pushedByBatch = new Map<string, number>();
  for (const r of (pushed || []) as any[]) {
    if (r.import_batch_id) pushedByBatch.set(r.import_batch_id, (pushedByBatch.get(r.import_batch_id) || 0) + 1);
  }
  return (imports as any[]).map((b) => ({
    id: b.id, file_name: b.file_name, sheet_count: b.sheet_count, row_count: b.row_count,
    total_amount_ex_tax: Number(b.total_amount_ex_tax) || 0, created_at: b.created_at,
    pushed_count: pushedByBatch.get(b.id) || 0,
  }));
}

/** 删除一批导入(级联删该批所有明细行)。已推财务的批禁删。 */
export async function deleteLedgerImport(batchId: string): Promise<{ ok: boolean; error?: string; deleted?: number }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };
    const svc = createServiceRoleClient();
    // 护栏:该批有已推财务的行 → 禁删(否则和财务应付脱节)
    const { count: pushedCount } = await (svc.from('supplier_fabric_ledger') as any)
      .select('id', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).not('payable_pushed_at', 'is', null);
    if ((pushedCount || 0) > 0) return { ok: false, error: `该批有 ${pushedCount} 行已推财务,不能删除(请先在财务作废对应应付)` };
    const { count: rowCount } = await (svc.from('supplier_fabric_ledger') as any)
      .select('id', { count: 'exact', head: true }).eq('import_batch_id', batchId);
    // 删批次头 → 明细行 ON DELETE CASCADE 一并删
    const { error } = await (svc.from('supplier_ledger_imports') as any).delete().eq('id', batchId);
    if (error) return { ok: false, error: friendlyError(error) };
    revalidatePath('/procurement/ledger');
    return { ok: true, deleted: rowCount || 0 };
  } catch (e: any) { return { ok: false, error: e?.message || '删除失败' }; }
}

/** 清空整个台账(所有批次+明细)。任一已推财务 → 拒绝,改为逐批删。 */
export async function clearAllLedger(): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: '未登录' };
    const gate = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_PROCUREMENT_EXEC', WRITE_MSG);
    if (gate) return { ok: false, error: gate };
    const svc = createServiceRoleClient();
    const { count: pushedCount } = await (svc.from('supplier_fabric_ledger') as any)
      .select('id', { count: 'exact', head: true }).not('payable_pushed_at', 'is', null);
    if ((pushedCount || 0) > 0) return { ok: false, error: `台账有 ${pushedCount} 行已推财务,不能整体清空(请逐批删未推的批次)` };
    // 删所有批次头(明细 CASCADE);再兜底删无批次的散行
    await (svc.from('supplier_ledger_imports') as any).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await (svc.from('supplier_fabric_ledger') as any).delete().is('payable_pushed_at', null);
    revalidatePath('/procurement/ledger');
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || '清空失败' }; }
}
