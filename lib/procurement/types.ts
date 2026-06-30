// ============================================================
// Procurement read-only view — types
// 全部为 DERIVED 输出（never stored）。procurement 层零 DB 写。
// ============================================================

export type ProductionStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'overdue';

/** 角色可见性能力（按真实角色解析，见 visibility.ts）。 */
export interface ProcurementCapabilities {
  view: boolean; // 能否访问采购视图
  supplierGrouping: boolean; // 看供应商级分组（sales/finance/production 不看）
  executionDetail: boolean; // 看采购执行明细（订/收/状态/议价）
  procurementCost: boolean; // 看物料采购成本（单价/金额）
  orderFinancials: boolean; // 看订单金额（= CAN_SEE_FINANCIALS）
  productionReadiness: boolean; // 看物料 readiness + 生产状态
}

export interface ProductionStageSummary {
  overall: ProductionStatus;
  current_step_key: string | null;
  current_step_name: string | null;
  total: number;
  completed: number;
  in_progress: number;
  blocked: number;
  overdue: number;
}

export interface OrderSummary {
  order_id: string;
  order_no: string;
  customer_name: string;
  style_no: string | null;
  quantity: number | null;
  incoterm: string | null;
  etd: string | null;
  factory_date: string | null;
  lifecycle_status: string | null;
  // 以下仅 orderFinancials=true 时填充：
  currency?: string | null;
  total_amount?: number | null;
  unit_price?: number | null;
  payment_terms?: string | null;
}

export interface NormalizedLineItem {
  line_no: number | null;
  style_no: string | null;
  color: string | null;
  size_breakdown: Record<string, number>;
  qty: number | null;
}

export interface MaterialGroup {
  material_key: string;
  material_code: string | null;
  material_name: string;
  category: string | null;
  unit: string | null;
  total_qty: number;
  // 仅 procurementCost=true：
  unit_price?: number | null;
  amount?: number | null;
}

export interface SupplierGroup {
  supplier_name: string; // 纯文本（无供应商主表）
  material_count: number;
  total_qty: number;
  materials: { material_name: string; qty: number; unit: string | null }[];
  // 仅 procurementCost=true：
  amount?: number | null;
}

export interface ProcurementExecutionLine {
  material_name: string;
  material_code: string | null;
  category: string | null;
  supplier_name: string | null;
  ordered_qty: number | null;
  ordered_unit: string | null;
  received_qty: number | null;
  status: string | null;
  // 仅 procurementCost=true：
  unit_price?: number | null;
}

export interface MaterialReadiness {
  total_materials: number;
  ordered: number;
  received: number;
  pending: number;
}

export interface ProcurementView {
  generated_at: string;
  derived: true; // 标记：派生，绝不存库
  viewer_capabilities: ProcurementCapabilities;
  order: OrderSummary;
  production_status: ProductionStageSummary;
  line_items: NormalizedLineItem[];
  group_by_material: MaterialGroup[];
  // 按能力裁剪（缺省 = 该角色不可见）：
  material_readiness?: MaterialReadiness;
  group_by_supplier?: SupplierGroup[];
  execution_detail?: ProcurementExecutionLine[];
}

export interface ReorderLine {
  style_no: string | null;
  color: string | null;
  size_breakdown: Record<string, number>;
  qty: number | null;
}

export interface ReorderPayload {
  derived: true; // payload-only，绝不写库
  source_order_id: string;
  source_order_no: string;
  customer_name: string;
  style_no: string | null;
  order_type: 'repeat';
  line_items: ReorderLine[];
  total_qty: number;
  note: string;
}

export interface QuoteToOrderValidation {
  valid: boolean;
  reason?: string;
  // 仅 valid=true：纯映射（不创建订单、不写库）
  mapping?: {
    origin_quote_id: string;
    quote_no: string;
    customer_name: string;
    style_no: string | null;
    quantity: number | null;
  };
}
