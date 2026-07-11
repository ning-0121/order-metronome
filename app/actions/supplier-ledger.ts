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
  invoice_status: string | null;
  delivery_note: string | null;
  customer_name: string | null;
  created_at: string;
}

export interface SupplierGroup {
  supplier_name_raw: string;
  supplier_id: string | null;
  matched: boolean;         // 是否已关联供应商主数据
  lineCount: number;
  totalAmount: number;      // 不含税
  unbilledCount: number;    // 「没见票」等未见票行数
  lines: LedgerLine[];
}

/** 读台账,按供应商分组(采购看总账)。 */
export async function getSupplierLedger(): Promise<{ groups: SupplierGroup[]; grandTotal: number }> {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('supplier_fabric_ledger') as any)
    .select('*')
    .order('supplier_name_raw', { ascending: true })
    .order('internal_order_no', { ascending: true })
    .order('created_at', { ascending: true });
  if (error || !data) return { groups: [], grandTotal: 0 };

  const map = new Map<string, SupplierGroup>();
  let grandTotal = 0;
  for (const l of data as LedgerLine[]) {
    const key = l.supplier_name_raw;
    if (!map.has(key)) {
      map.set(key, {
        supplier_name_raw: l.supplier_name_raw,
        supplier_id: l.supplier_id,
        matched: !!l.supplier_id,
        lineCount: 0, totalAmount: 0, unbilledCount: 0, lines: [],
      });
    }
    const g = map.get(key)!;
    g.lines.push(l);
    g.lineCount += 1;
    const amt = Number(l.amount_ex_tax) || 0;
    g.totalAmount += amt;
    grandTotal += amt;
    if (l.invoice_status && /没见票|未见票|未收票|无票/.test(l.invoice_status)) g.unbilledCount += 1;
  }
  const groups = [...map.values()].map((g) => ({ ...g, totalAmount: round2(g.totalAmount) }))
    .sort((a, b) => b.totalAmount - a.totalAmount);
  return { groups, grandTotal: round2(grandTotal) };
}
