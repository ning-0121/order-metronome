// ============================================================
// Procurement read-only VIEW generator
// 输入: order_id + viewer capabilities
// 输出: 派生视图（订单摘要 + 规范化明细 + 生产状态 + 按物料/供应商/阶段分组）
// 铁律: 全部 READ-ONLY（只 .select()）；DERIVED-never-stored；按能力裁剪。
// 数据源: orders · order_line_items · procurement_line_items · materials_bom · milestones
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ProcurementCapabilities,
  ProcurementView,
  OrderSummary,
  NormalizedLineItem,
  MaterialGroup,
  SupplierGroup,
  ProcurementExecutionLine,
  MaterialReadiness,
} from './types';
import { deriveProductionStatus, type MilestoneInput } from './status';

interface OrderRow {
  id: string;
  order_no: string;
  customer_name: string;
  style_no: string | null;
  quantity: number | null;
  incoterm: string | null;
  etd: string | null;
  factory_date: string | null;
  lifecycle_status: string | null;
  currency: string | null;
  total_amount: number | null;
  unit_price: number | null;
  payment_terms: string | null;
}
interface LineRow {
  line_no: number | null;
  style_no: string | null;
  color_cn: string | null;
  color_en: string | null;
  sizes: Record<string, number> | null;
  qty_pcs: number | null;
}
interface ProcLineRow {
  material_name: string | null;
  material_code: string | null;
  category: string | null;
  specification: string | null;
  supplier_name: string | null;
  ordered_qty: number | null;
  ordered_unit: string | null;
  unit_price: number | null;
  received_qty: number | null;
  status: string | null;
}
interface BomRow {
  material_name: string | null;
  material_code: string | null;
  material_type: string | null;
  unit: string | null;
  qty_per_piece: number | null;
  total_qty: number | null;
  unit_cost: number | null;
  supplier: string | null;
}

function normSupplier(name: string | null | undefined): string {
  return (name ?? '').trim() || '(未指定供应商)';
}
function matKey(code: string | null, name: string | null, category: string | null): string {
  return `${(code ?? '').trim()}|${(name ?? '').trim()}|${(category ?? '').trim()}`.toLowerCase();
}
function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function buildProcurementView(
  supabase: SupabaseClient,
  orderId: string,
  caps: ProcurementCapabilities,
  nowIso: string,
): Promise<ProcurementView | null> {
  // ---- order summary ----
  const { data: od } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, style_no, quantity, incoterm, etd, factory_date, lifecycle_status, currency, total_amount, unit_price, payment_terms')
    .eq('id', orderId)
    .maybeSingle();
  const o = od as OrderRow | null;
  if (!o) return null;

  const order: OrderSummary = {
    order_id: o.id,
    order_no: o.order_no,
    customer_name: o.customer_name,
    style_no: o.style_no ?? null,
    quantity: o.quantity ?? null,
    incoterm: o.incoterm ?? null,
    etd: o.etd ?? null,
    factory_date: o.factory_date ?? null,
    lifecycle_status: o.lifecycle_status ?? null,
  };
  if (caps.orderFinancials) {
    order.currency = o.currency ?? null;
    order.total_amount = o.total_amount ?? null;
    order.unit_price = o.unit_price ?? null;
    order.payment_terms = o.payment_terms ?? null;
  }

  // ---- normalized line items ----
  const { data: lid } = await supabase
    .from('order_line_items')
    .select('line_no, style_no, color_cn, color_en, sizes, qty_pcs')
    .eq('order_id', orderId)
    .order('line_no');
  const line_items: NormalizedLineItem[] = ((lid as LineRow[] | null) ?? []).map((l) => ({
    line_no: l.line_no ?? null,
    style_no: l.style_no ?? null,
    color: l.color_en ?? l.color_cn ?? null,
    size_breakdown: l.sizes ?? {},
    qty: l.qty_pcs ?? null,
  }));

  // ---- production status (from milestones) ----
  const { data: msd } = await supabase
    .from('milestones')
    .select('step_key, name, status, sequence_number')
    .eq('order_id', orderId)
    .order('sequence_number');
  const production_status = deriveProductionStatus((msd as MilestoneInput[] | null) ?? []);

  // ---- procurement execution lines (primary source) ----
  const { data: pld } = await supabase
    .from('procurement_line_items')
    .select('material_name, material_code, category, specification, supplier_name, ordered_qty, ordered_unit, unit_price, received_qty, status')
    .eq('order_id', orderId);
  const procLines = (pld as ProcLineRow[] | null) ?? [];

  // ---- BOM (material requirement / fallback grouping source) ----
  const { data: bomd } = await supabase
    .from('materials_bom')
    .select('material_name, material_code, material_type, unit, qty_per_piece, total_qty, unit_cost, supplier')
    .eq('order_id', orderId);
  const bom = (bomd as BomRow[] | null) ?? [];

  // ---- group by material（优先 procurement 行；无则回退 BOM 需求）----
  const matMap = new Map<string, MaterialGroup>();
  const useProc = procLines.length > 0;
  if (useProc) {
    for (const p of procLines) {
      const key = matKey(p.material_code, p.material_name, p.category);
      const g = matMap.get(key) ?? {
        material_key: key,
        material_code: p.material_code ?? null,
        material_name: p.material_name ?? '(未命名物料)',
        category: p.category ?? null,
        unit: p.ordered_unit ?? null,
        total_qty: 0,
        ...(caps.procurementCost ? { amount: 0 } : {}),
      };
      g.total_qty += num(p.ordered_qty);
      if (caps.procurementCost) {
        g.unit_price = p.unit_price ?? g.unit_price ?? null;
        g.amount = num(g.amount) + num(p.ordered_qty) * num(p.unit_price);
      }
      matMap.set(key, g);
    }
  } else {
    for (const b of bom) {
      const key = matKey(b.material_code, b.material_name, b.material_type);
      const g = matMap.get(key) ?? {
        material_key: key,
        material_code: b.material_code ?? null,
        material_name: b.material_name ?? '(未命名物料)',
        category: b.material_type ?? null,
        unit: b.unit ?? null,
        total_qty: 0,
        ...(caps.procurementCost ? { amount: 0 } : {}),
      };
      g.total_qty += num(b.total_qty);
      if (caps.procurementCost) {
        g.unit_price = b.unit_cost ?? g.unit_price ?? null;
        g.amount = num(g.amount) + num(b.total_qty) * num(b.unit_cost);
      }
      matMap.set(key, g);
    }
  }
  const group_by_material = [...matMap.values()].sort((a, b) => a.material_name.localeCompare(b.material_name));

  const view: ProcurementView = {
    generated_at: nowIso,
    derived: true,
    viewer_capabilities: caps,
    order,
    production_status,
    line_items,
    group_by_material,
  };

  // ---- material readiness（productionReadiness）----
  if (caps.productionReadiness) {
    const readiness: MaterialReadiness = {
      total_materials: procLines.length,
      ordered: procLines.filter((p) => (p.status ?? '') !== '' && p.status !== 'cancelled').length,
      received: procLines.filter((p) => num(p.received_qty) > 0 || p.status === 'complete').length,
      pending: procLines.filter((p) => !p.status || p.status === 'ordered').length,
    };
    view.material_readiness = readiness;
  }

  // ---- group by supplier（仅 supplierGrouping；纯文本名归并，无主表）----
  if (caps.supplierGrouping) {
    const supMap = new Map<string, SupplierGroup>();
    const supplierSource = useProc
      ? procLines.map((p) => ({ name: p.supplier_name, mat: p.material_name, qty: p.ordered_qty, unit: p.ordered_unit, price: p.unit_price }))
      : bom.map((b) => ({ name: b.supplier, mat: b.material_name, qty: b.total_qty, unit: b.unit, price: b.unit_cost }));
    for (const s of supplierSource) {
      const name = normSupplier(s.name);
      const g = supMap.get(name) ?? {
        supplier_name: name,
        material_count: 0,
        total_qty: 0,
        materials: [],
        ...(caps.procurementCost ? { amount: 0 } : {}),
      };
      g.material_count += 1;
      g.total_qty += num(s.qty);
      g.materials.push({ material_name: s.mat ?? '(未命名物料)', qty: num(s.qty), unit: s.unit ?? null });
      if (caps.procurementCost) g.amount = num(g.amount) + num(s.qty) * num(s.price);
      supMap.set(name, g);
    }
    view.group_by_supplier = [...supMap.values()].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));
  }

  // ---- execution detail（仅 executionDetail）----
  if (caps.executionDetail) {
    view.execution_detail = procLines.map((p): ProcurementExecutionLine => ({
      material_name: p.material_name ?? '(未命名物料)',
      material_code: p.material_code ?? null,
      category: p.category ?? null,
      supplier_name: p.supplier_name ?? null,
      ordered_qty: p.ordered_qty ?? null,
      ordered_unit: p.ordered_unit ?? null,
      received_qty: p.received_qty ?? null,
      status: p.status ?? null,
      ...(caps.procurementCost ? { unit_price: p.unit_price ?? null } : {}),
    }));
  }

  return view;
}
