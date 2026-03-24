export type OwnerRole =
  | "sales"
  | "merchandiser"
  | "finance"
  | "procurement"
  | "production"
  | "qc"
  | "logistics"
  | "admin";

/**
 * V1 托底闭环：20个里程碑模板
 * step_key 必须与 lib/schedule.ts calcDueDates() 返回的 key 一一对应
 */
export const MILESTONE_TEMPLATE_V1: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
}> = [
  // 阶段1：订单启动
  { step_key: "po_confirmed", name: "PO确认", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "finance_approval", name: "财务审核", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "production_order_upload", name: "生产单上传", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "production_resources_confirmed", name: "生产资源确认", owner_role: "production", is_critical: true, evidence_required: false },
  // 阶段2：订单转化
  { step_key: "order_docs_bom_complete", name: "订单资料/BOM齐全", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "bulk_materials_confirmed", name: "大货原辅料确认", owner_role: "procurement", is_critical: true, evidence_required: false },
  // 阶段3：产前样
  { step_key: "pre_production_sample_ready", name: "产前样准备完成", owner_role: "qc", is_critical: true, evidence_required: false },
  { step_key: "pre_production_sample_sent", name: "产前样寄出", owner_role: "sales", is_critical: true, evidence_required: false },
  { step_key: "pre_production_sample_approved", name: "产前样客户确认", owner_role: "sales", is_critical: true, evidence_required: true },
  // 阶段4：采购与生产
  { step_key: "procurement_order_placed", name: "采购订单下达", owner_role: "procurement", is_critical: true, evidence_required: false },
  { step_key: "materials_received_inspected", name: "原辅料到货验收", owner_role: "qc", is_critical: true, evidence_required: false },
  { step_key: "production_kickoff", name: "生产启动/开裁", owner_role: "production", is_critical: true, evidence_required: false },
  { step_key: "pre_production_meeting", name: "产前会", owner_role: "production", is_critical: false, evidence_required: false },
  // 阶段5：过程控制
  { step_key: "mid_qc_check", name: "中查", owner_role: "qc", is_critical: false, evidence_required: false },
  { step_key: "final_qc_check", name: "尾查", owner_role: "qc", is_critical: true, evidence_required: false },
  // 阶段6：出货控制
  { step_key: "packing_method_confirmed", name: "包装方式业务确认", owner_role: "sales", is_critical: true, evidence_required: false },
  { step_key: "inspection_release", name: "验货/放行", owner_role: "qc", is_critical: true, evidence_required: true },
  { step_key: "shipping_sample_send", name: "船样寄送", owner_role: "sales", is_critical: false, evidence_required: false },
  // 阶段7：物流收款
  { step_key: "booking_done", name: "订舱完成", owner_role: "logistics", is_critical: true, evidence_required: true },
  { step_key: "customs_export", name: "报关出运", owner_role: "logistics", is_critical: true, evidence_required: true },
  { step_key: "payment_received", name: "收款完成", owner_role: "finance", is_critical: true, evidence_required: false },
];

/**
 * 根据订单类型返回适用的里程碑模板（V1 返回全部）
 */
export function getApplicableMilestones(_orderType?: string, _shippingSampleRequired?: boolean) {
  return MILESTONE_TEMPLATE_V1;
}
