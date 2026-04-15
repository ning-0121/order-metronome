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
 * V1 托底闭环：21个里程碑模板
 * step_key 必须与 lib/schedule.ts calcDueDates() 返回的 key 一一对应
 *
 * 角色分工：
 * - sales: 业务（客户沟通、生产单制作、原辅料单制作、原辅料验收、产前样验收/寄送、包装确认、船样、订舱、报关）
 * - merchandiser: 跟单（生产单执行、工厂报价产能协调、产前样安排、产前会、生产进度跟进、中查尾查、验货放行）
 * - finance: 财务（PO审核、原辅料成本审核、货代费用审核、收款和出货许可）
 * - production_manager: 生产主管（加工费确认、生产协调）
 * - procurement: 采购（原辅料审核对比、价格谈判、采购计划、采购单下达、供应商跟进、大货品质确认）
 * - logistics: 物流（出货装货与运输事宜安排）
 */
export const MILESTONE_TEMPLATE_V1: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
}> = [
  // 阶段1：订单评审
  { step_key: "po_confirmed", name: "PO确认", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "finance_approval", name: "财务审核", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "order_kickoff_meeting", name: "订单评审会", owner_role: "sales", is_critical: true, evidence_required: false },
  { step_key: "production_order_upload", name: "生产单上传", owner_role: "sales", is_critical: true, evidence_required: true },
  // 阶段2：预评估
  { step_key: "order_docs_bom_complete", name: "BOM/采购预评估", owner_role: "procurement", is_critical: true, evidence_required: false },
  { step_key: "bulk_materials_confirmed", name: "生产预评估", owner_role: "production_manager", is_critical: true, evidence_required: false },
  // 阶段3：工厂匹配 & 产前样
  { step_key: "processing_fee_confirmed", name: "加工费确认", owner_role: "production_manager", is_critical: true, evidence_required: true },
  { step_key: "factory_confirmed", name: "工厂匹配确认", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "pre_production_sample_ready", name: "产前样准备完成", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "pre_production_sample_sent", name: "产前样寄出", owner_role: "sales", is_critical: true, evidence_required: false },
  { step_key: "pre_production_sample_approved", name: "产前样客户确认", owner_role: "sales", is_critical: true, evidence_required: true },
  // 阶段4：采购与生产准备
  // 顺序修复（2026-04-08）：产前会必须在原料到货后、开裁前
  { step_key: "procurement_order_placed", name: "采购订单下达", owner_role: "procurement", is_critical: true, evidence_required: true },
  { step_key: "materials_received_inspected", name: "原辅料到货验收", owner_role: "merchandiser", is_critical: true, evidence_required: false },
  { step_key: "pre_production_meeting", name: "产前会", owner_role: "merchandiser", is_critical: false, evidence_required: false },
  { step_key: "production_kickoff", name: "生产启动/开裁", owner_role: "merchandiser", is_critical: true, evidence_required: false },
  // 阶段5：过程控制（验货分跟单 + 业务双重把关）
  { step_key: "mid_qc_check", name: "跟单中查", owner_role: "merchandiser", is_critical: false, evidence_required: true },
  { step_key: "mid_qc_sales_check", name: "业务中查", owner_role: "sales", is_critical: false, evidence_required: true },
  // 阶段6：出货控制
  // 顺序修复（2026-04-08）：包装确认 → 船样寄送 → 尾查 → 工厂完成 → 验货放行
  { step_key: "packing_method_confirmed", name: "包装方式确认", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "shipping_sample_send", name: "船样寄送", owner_role: "sales", is_critical: false, evidence_required: false },
  { step_key: "final_qc_check", name: "跟单尾查", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "final_qc_sales_check", name: "业务尾查", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "factory_completion", name: "工厂完成", owner_role: "merchandiser", is_critical: true, evidence_required: false },
  { step_key: "leftover_collection", name: "剩余物料回收", owner_role: "merchandiser", is_critical: false, evidence_required: true, evidence_note: "提交剩余面料/辅料数量 + 废料数量" },
  { step_key: "finished_goods_warehouse", name: "成品入库", owner_role: "logistics", is_critical: true, evidence_required: true, evidence_note: "提交入库单（成品数量/次品/余量/样品扣除）" },
  { step_key: "inspection_release", name: "验货/放行", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  // 阶段7：物流收款
  { step_key: "booking_done", name: "订舱完成", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "customs_export", name: "报关安排出运", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "finance_shipment_approval", name: "核准出运", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "shipment_execute", name: "出运", owner_role: "logistics", is_critical: true, evidence_required: true },
  { step_key: "payment_received", name: "收款完成", owner_role: "finance", is_critical: true, evidence_required: false },
];

/**
 * 国内送仓订单需要跳过的出运节点
 * 这些节点只有出口订单（DDP）才需要
 * FOB / 人民币含税 / 人民币不含税 → 都走送仓流程
 */
const EXPORT_ONLY_STEPS = new Set([
  'shipping_sample_send',       // 船样寄送
  'booking_done',               // 订舱完成
  'customs_export',             // 报关安排出运
  'finance_shipment_approval',  // 核准出运
  'shipment_execute',           // 出运
]);

/**
 * 不需要产前样的订单跳过的节点
 * 适用于：客户直接用设计样 / 翻单 / 老款直接大货
 */
const PRE_PRODUCTION_SAMPLE_STEPS = new Set([
  'pre_production_sample_ready',
  'pre_production_sample_sent',
  'pre_production_sample_approved',
]);

/**
 * 国内送仓订单追加的节点（替代出运节点）
 */
const DOMESTIC_MILESTONES: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
}> = [
  { step_key: "domestic_delivery", name: "国内送仓完成", owner_role: "logistics", is_critical: true, evidence_required: true },
];

/**
 * 打样专用里程碑模板（7个节点，14天周期）
 */
export const SAMPLE_MILESTONE_TEMPLATE: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  // 阶段1：打样启动
  { step_key: "sample_confirm", name: "打样单确认", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传客户打样需求（Tech Pack/参考图/尺码表/面料要求）" },
  // 阶段2：面料与制作
  { step_key: "sample_material", name: "打样面料采购", owner_role: "procurement", is_critical: true, evidence_required: false },
  { step_key: "sample_making", name: "打样制作", owner_role: "merchandiser", is_critical: true, evidence_required: false },
  // 阶段3：检验
  { step_key: "sample_qc", name: "打样检验", owner_role: "merchandiser", is_critical: true, evidence_required: true,
    evidence_note: "上传样品照片（正面/背面/细节/尺寸测量）" },
  // 阶段4：寄样
  { step_key: "sample_shipping_arrange", name: "寄样安排", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传快递单号。⚠ 国际快递必须确认：DHL/FedEx/UPS + DDP（完税交货）还是 DDU。DDP 必须含税，否则客户投诉！" },
  { step_key: "sample_sent", name: "样品寄出", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传快递面单照片 + 跟踪号" },
  // 阶段5：客户确认
  { step_key: "sample_customer_confirm", name: "客户确认样品", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传客户确认邮件/消息截图。如需修改请记录修改点" },
  { step_key: "sample_complete", name: "打样完成", owner_role: "sales", is_critical: true, evidence_required: false },
];

/**
 * 根据订单类型和交付方式返回适用的里程碑模板
 *
 * 出运流程判定：deliveryType === 'export' → 走 DDP 出运流程
 * 只有 DDP 需要我们订舱/报关/出运；FOB / 人民币(含税/不含税) 都走送仓流程。
 * 表单层面会根据 incoterm 自动设置 deliveryType（DDP→export，其余→domestic）。
 *
 * @param deliveryType - 'export'(DDP出口) | 'domestic'(送仓)
 * @param orderPurpose - 'production' | 'sample'
 * @param skipPreProductionSample - 是否跳过产前样（客户直接用设计样）
 */
export function getApplicableMilestones(
  _orderType?: string,
  _shippingSampleRequired?: boolean,
  deliveryType?: string,
  orderPurpose?: string,
  skipPreProductionSample?: boolean,
) {
  // 打样单用简化模板
  if (orderPurpose === 'sample') {
    return SAMPLE_MILESTONE_TEMPLATE;
  }

  let template = [...MILESTONE_TEMPLATE_V1];

  // 跳过产前样节点（客户用设计样直接做大货 / 翻单 / 老款）
  if (skipPreProductionSample) {
    template = template.filter(m => !PRE_PRODUCTION_SAMPLE_STEPS.has(m.step_key));
  }

  if (deliveryType !== 'export') {
    // 非出口（FOB / 人民币 / 国内送仓）：过滤出运节点，追加国内送仓节点
    const filtered = template.filter(m => !EXPORT_ONLY_STEPS.has(m.step_key));
    return [...filtered, ...DOMESTIC_MILESTONES];
  }

  return template;
}
