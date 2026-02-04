export type OwnerRole =
  | "sales"
  | "finance"
  | "procurement"
  | "production"
  | "qc"
  | "logistics"
  | "admin";

/**
 * V1 托底闭环：18个里程碑模板
 * A. Order Setup Chain (7)
 * B. PPS & Start Production (4)
 * C. Production → Shipping (5)
 * D. Ship & Payment (2)
 */
export const MILESTONE_TEMPLATE_V1: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
}> = [
  // A. Order Setup Chain (7)
  { step_key: "po_confirmed", name: "PO确认", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "finance_approval", name: "财务审核", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "order_docs_complete", name: "订单资料齐全", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "rm_purchase_sheet_submit", name: "原辅料采购单提交", owner_role: "sales", is_critical: true, evidence_required: false },
  { step_key: "finance_purchase_approval", name: "财务采购审核", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "procurement_order_placed", name: "采购订单下达", owner_role: "procurement", is_critical: true, evidence_required: false },
  { step_key: "materials_received_inspected", name: "原辅料到货验收", owner_role: "qc", is_critical: true, evidence_required: false },
  
  // B. PPS & Start Production (4)
  { step_key: "pps_ready", name: "产前样准备完成", owner_role: "qc", is_critical: true, evidence_required: false },
  { step_key: "pps_sent", name: "产前样寄出", owner_role: "sales", is_critical: true, evidence_required: false },
  { step_key: "pps_customer_approved", name: "产前样客户确认", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "production_start", name: "生产启动", owner_role: "production", is_critical: true, evidence_required: false },
  
  // C. Production → Shipping (5)
  { step_key: "mid_qc_check", name: "中查", owner_role: "qc", is_critical: false, evidence_required: false },
  { step_key: "final_qc_check", name: "尾查", owner_role: "qc", is_critical: true, evidence_required: false },
  { step_key: "packaging_materials_ready", name: "包装辅料到位", owner_role: "procurement", is_critical: true, evidence_required: false },
  { step_key: "packing_labeling_done", name: "包装贴标完成", owner_role: "logistics", is_critical: true, evidence_required: false },
  { step_key: "booking_done", name: "订舱完成", owner_role: "logistics", is_critical: true, evidence_required: true },
  
  // D. Ship & Payment (2)
  { step_key: "shipment_done", name: "出货完成", owner_role: "logistics", is_critical: true, evidence_required: true },
  { step_key: "payment_received", name: "收款完成", owner_role: "finance", is_critical: true, evidence_required: false },
];
