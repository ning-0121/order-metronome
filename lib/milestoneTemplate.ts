export type OwnerRole =
  | 'sales'
  | 'finance'
  | 'procurement'
  | 'production'
  | 'qc'
  | 'logistics'
  | 'admin';

export interface MilestoneTemplate {
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  /** 仅在 order_type='sample' 时包含 */
  sample_only?: boolean;
  /** 仅在 shipping_sample_required=true 时包含 */
  shipping_sample_only?: boolean;
}

/**
 * V2 PO 级里程碑模板（19节点）
 *
 * A. 订单启动（7）  — T0 = order_date
 * B. 产前样 & 生产（4）
 * C. 生产出货（5）
 * X. Shipping Sample（1）— 仅在 shipping_sample_required=true 时生效
 * D. 出运收款（2）
 *
 * order_type='sample' 时跳过 mid_qc_check；
 * shipping_sample_required=true 时加入 shipping_sample_send 节点。
 */
export const MILESTONE_TEMPLATE_V2: MilestoneTemplate[] = [
  // A. 订单启动（7）
  { step_key: 'po_confirmed',               name: 'PO确认',          owner_role: 'sales',       is_critical: true,  evidence_required: true  },
  { step_key: 'finance_approval',           name: '财务审核',         owner_role: 'finance',     is_critical: true,  evidence_required: false },
  { step_key: 'order_docs_complete',        name: '订单资料齐全',     owner_role: 'sales',       is_critical: true,  evidence_required: true  },
  { step_key: 'rm_purchase_sheet_submit',   name: '原辅料采购单提交', owner_role: 'sales',       is_critical: true,  evidence_required: false },
  { step_key: 'finance_purchase_approval',  name: '财务采购审核',     owner_role: 'finance',     is_critical: true,  evidence_required: false },
  { step_key: 'procurement_order_placed',   name: '采购订单下达',     owner_role: 'procurement', is_critical: true,  evidence_required: false },
  { step_key: 'materials_received_inspected', name: '原辅料到货验收', owner_role: 'qc',          is_critical: true,  evidence_required: false },

  // B. 产前样 & 生产（4）
  { step_key: 'pps_ready',               name: '产前样准备完成',   owner_role: 'qc',         is_critical: true,  evidence_required: false },
  { step_key: 'pps_sent',                name: '产前样寄出',       owner_role: 'sales',      is_critical: true,  evidence_required: false },
  { step_key: 'pps_customer_approved',   name: '产前样客户确认',   owner_role: 'sales',      is_critical: true,  evidence_required: true  },
  { step_key: 'production_start',        name: '生产启动',         owner_role: 'production', is_critical: true,  evidence_required: false },

  // C. 生产出货（5）
  { step_key: 'mid_qc_check',            name: '中查',             owner_role: 'qc',         is_critical: false, evidence_required: false },
  { step_key: 'final_qc_check',          name: '尾查',             owner_role: 'qc',         is_critical: true,  evidence_required: false },
  { step_key: 'packaging_materials_ready', name: '包装辅料到位',   owner_role: 'procurement', is_critical: true, evidence_required: false },
  { step_key: 'packing_labeling_done',   name: '包装贴标完成',     owner_role: 'logistics',  is_critical: true,  evidence_required: false },
  { step_key: 'booking_done',            name: '订舱完成',         owner_role: 'logistics',  is_critical: true,  evidence_required: true  },

  // X. Shipping Sample（条件节点）
  { step_key: 'shipping_sample_send',    name: 'Shipping Sample 寄出', owner_role: 'logistics', is_critical: true, evidence_required: true, shipping_sample_only: true },

  // D. 出运收款（2）
  { step_key: 'shipment_done',           name: '出货完成',         owner_role: 'logistics',  is_critical: true,  evidence_required: true  },
  { step_key: 'payment_received',        name: '收款完成',         owner_role: 'finance',    is_critical: true,  evidence_required: false },
];

/** 兼容旧代码：保留 V1 导出名 */
export const MILESTONE_TEMPLATE_V1 = MILESTONE_TEMPLATE_V2;

/**
 * 根据订单类型和 shipping_sample_required 过滤节点
 */
export function getApplicableMilestones(
  orderType: 'sample' | 'bulk' | 'repeat' = 'bulk',
  shippingSampleRequired = false
): MilestoneTemplate[] {
  return MILESTONE_TEMPLATE_V2.filter(m => {
    // Shipping Sample 节点：仅在需要时包含
    if (m.shipping_sample_only && !shippingSampleRequired) return false;
    return true;
  });
}
