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
  /** 凭证说明（描述需要上传什么） */
  evidence_note?: string;
  /** 阻断规则：此节点未完成则阻断哪些节点 */
  blocks?: string[];
  /** 仅在 shipping_sample_required=true 时包含 */
  shipping_sample_only?: boolean;
}

/**
 * V3 PO 级里程碑模板（22节点，最小闭环）
 *
 * 依赖链（硬阻断规则）：
 *   order_docs_complete           → bulk_materials_confirmed
 *   bulk_materials_confirmed      → procurement_order_placed
 *   procurement_order_placed      → materials_received_inspected
 *   materials_received_inspected  → production_start（cutting）
 *   pre_production_sample_approved → production_start
 *   final_qc_check                → packing_method_confirmed
 *   packing_method_confirmed      → packing_labeling_done
 *   shipping_sample_approved      → booking_done（当 shipping_sample_required=true）
 */
export const MILESTONE_TEMPLATE_V3: MilestoneTemplate[] = [

  // ── A. 订单启动（8）──────────────────────────────────────────────
  {
    step_key: 'po_confirmed',
    name: 'PO 确认',
    owner_role: 'sales',
    is_critical: true,
    evidence_required: true,
    evidence_note: '上传客户 PO 文件',
    blocks: ['finance_approval'],
  },
  {
    step_key: 'finance_approval',
    name: '财务审核',
    owner_role: 'finance',
    is_critical: true,
    evidence_required: false,
    blocks: ['order_docs_complete'],
  },
  {
    step_key: 'order_docs_complete',
    name: '订单资料齐全',
    owner_role: 'sales',
    is_critical: true,
    evidence_required: true,
    evidence_note: '上传生产制单 + 工艺单',
    blocks: ['bulk_materials_confirmed'],
  },
  {
    step_key: 'bulk_materials_confirmed',
    name: '大货原辅料确认',
    owner_role: 'procurement',
    is_critical: true,
    evidence_required: true,
    evidence_note: '确认主面料款号/色号/克重、辅料清单、风险标注（高弹/浅色/大码）',
    blocks: ['procurement_order_placed'],
  },
  {
    step_key: 'finance_purchase_approval',
    name: '财务采购审核',
    owner_role: 'finance',
    is_critical: true,
    evidence_required: false,
    blocks: ['procurement_order_placed'],
  },
  {
    step_key: 'procurement_order_placed',
    name: '采购订单下达',
    owner_role: 'procurement',
    is_critical: true,
    evidence_required: false,
    blocks: ['materials_received_inspected'],
  },
  {
    step_key: 'materials_received_inspected',
    name: '原辅料到货验收',
    owner_role: 'qc',
    is_critical: true,
    evidence_required: true,
    evidence_note: '验收报告 / 来样照片',
    blocks: ['production_start'],
  },

  // ── B. 产前样（3）────────────────────────────────────────────────
  {
    step_key: 'pre_production_sample_ready',
    name: '产前样制作完成',
    owner_role: 'qc',
    is_critical: true,
    evidence_required: true,
    evidence_note: '产前样照片（正反面 + 细节）',
    blocks: ['pre_production_sample_sent'],
  },
  {
    step_key: 'pre_production_sample_sent',
    name: '产前样寄出',
    owner_role: 'sales',
    is_critical: true,
    evidence_required: true,
    evidence_note: '快递单号截图',
    blocks: ['pre_production_sample_approved'],
  },
  {
    step_key: 'pre_production_sample_approved',
    name: '产前样客户确认',
    owner_role: 'sales',
    is_critical: true,
    evidence_required: true,
    evidence_note: '客户确认邮件 / 系统审批截图',
    blocks: ['production_start'],
  },

  // ── C. 生产（2）──────────────────────────────────────────────────
  {
    step_key: 'production_start',
    name: '裁床开启（生产启动）',
    owner_role: 'production',
    is_critical: true,
    evidence_required: false,
    blocks: ['mid_qc_check', 'final_qc_check'],
  },
  {
    step_key: 'mid_qc_check',
    name: '中查',
    owner_role: 'qc',
    is_critical: false,
    evidence_required: true,
    evidence_note: '中查报告（抽检比例 + 问题清单）',
  },

  // ── D. QC + 出货准备（5）────────────────────────────────────────
  {
    step_key: 'final_qc_check',
    name: '尾查（Final Inspection）',
    owner_role: 'qc',
    is_critical: true,
    evidence_required: true,
    evidence_note: 'AQL 检验报告 + 证书',
    blocks: ['packing_method_confirmed'],
  },
  {
    step_key: 'packing_method_confirmed',
    name: '装箱方式现场确认',
    owner_role: 'sales',
    is_critical: true,
    evidence_required: true,
    evidence_note: '现场装箱方式照片（折叠方式 + 尺码条位置 + 唛头位）',
    blocks: ['packing_labeling_done'],
  },
  {
    step_key: 'packaging_materials_ready',
    name: '包装辅料到位',
    owner_role: 'procurement',
    is_critical: true,
    evidence_required: false,
    blocks: ['packing_labeling_done'],
  },
  {
    step_key: 'packing_labeling_done',
    name: '装箱贴标放行',
    owner_role: 'logistics',
    is_critical: true,
    evidence_required: true,
    evidence_note: '装箱单 + 唛头照片',
    blocks: ['booking_done'],
  },
  {
    step_key: 'booking_done',
    name: '订舱完成',
    owner_role: 'logistics',
    is_critical: true,
    evidence_required: true,
    evidence_note: 'Booking Confirmation',
    blocks: ['shipment_done'],
  },

  // ── E. Shipping Sample（条件节点）──────────────────────────────
  {
    step_key: 'shipping_sample_send',
    name: 'Shipping Sample 寄出',
    owner_role: 'logistics',
    is_critical: true,
    evidence_required: true,
    evidence_note: '快递单号 + 寄样清单',
    blocks: ['shipping_sample_approved'],
    shipping_sample_only: true,
  },
  {
    step_key: 'shipping_sample_approved',
    name: 'Shipping Sample 客户确认',
    owner_role: 'sales',
    is_critical: true,
    evidence_required: true,
    evidence_note: '客户确认邮件截图',
    blocks: ['booking_done'],
    shipping_sample_only: true,
  },

  // ── F. 出运收款（2）─────────────────────────────────────────────
  {
    step_key: 'shipment_done',
    name: '出货完成',
    owner_role: 'logistics',
    is_critical: true,
    evidence_required: true,
    evidence_note: 'B/L 提单 + 出货照片',
    blocks: ['payment_received'],
  },
  {
    step_key: 'payment_received',
    name: '收款完成',
    owner_role: 'finance',
    is_critical: true,
    evidence_required: false,
  },
];

/** 兼容旧代码 */
export const MILESTONE_TEMPLATE_V1 = MILESTONE_TEMPLATE_V3;
export const MILESTONE_TEMPLATE_V2 = MILESTONE_TEMPLATE_V3;

/**
 * 根据订单类型和 shipping_sample_required 过滤节点
 */
export function getApplicableMilestones(
  orderType: 'sample' | 'bulk' | 'repeat' = 'bulk',
  shippingSampleRequired = false
): MilestoneTemplate[] {
  return MILESTONE_TEMPLATE_V3.filter(m => {
    if (m.shipping_sample_only && !shippingSampleRequired) return false;
    return true;
  });
}

/** 返回所有依赖关系 map：step_key → 被此节点阻断的 step_keys[] */
export function getDependencyMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const m of MILESTONE_TEMPLATE_V3) {
    if (m.blocks && m.blocks.length > 0) {
      map[m.step_key] = m.blocks;
    }
  }
  return map;
}
