export type OwnerRole =
  | 'sales' | 'finance' | 'procurement'
  | 'production' | 'qc' | 'logistics' | 'admin';

export interface MilestoneTemplate {
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  /** 完成时限说明（相对锚点） */
  deadline_hint: string;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note: string;
  /** 此节点未完成则阻断哪些后续节点 */
  blocks: string[];
  /** 仅在 shipping_sample_required=true 时包含 */
  shipping_sample_only?: boolean;
  /** 可申请延期 */
  can_delay?: boolean;
}

/**
 * ✅ 订单节拍器 V1 最终节点表（20节点）
 *
 * 阶段1：订单启动（3）
 * 阶段2：订单转化（2）
 * 阶段3：产前样（3）
 * 阶段4：采购与生产（4）
 * 阶段5：过程控制（2）
 * 阶段6：出货控制（3）
 * 阶段7：物流收款（3）
 */
export const MILESTONE_TEMPLATE_FINAL: MilestoneTemplate[] = [

  // ══ 阶段1：订单启动（3）══════════════════════════════════════
  {
    step_key: 'po_confirmed',
    name: '客户PO确认',
    owner_role: 'sales',
    deadline_hint: '下单当天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '上传客户PO文件 + 客户确认邮件截图',
    blocks: ['finance_approval'],
  },
  {
    step_key: 'finance_approval',
    name: '财务审核',
    owner_role: 'finance',
    deadline_hint: 'T0 + 1天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '财务审批记录截图',
    blocks: ['production_order_upload'],
    can_delay: true,
  },
  {
    step_key: 'production_order_upload',
    name: '生产单上传',
    owner_role: 'sales',
    deadline_hint: '财务审核完成 + 2天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '上传生产单文件（PDF/Excel）',
    blocks: ['production_resources_confirmed'],
  },
  {
    step_key: 'production_resources_confirmed',
    name: '生产资源确认（工厂+加工费）',
    owner_role: 'production',
    deadline_hint: 'T0 + 2天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '工厂确认函 + 加工费报价单',
    blocks: ['order_docs_bom_complete'],
  },

  // ══ 阶段2：订单转化（2）══════════════════════════════════════
  {
    step_key: 'order_docs_bom_complete',
    name: 'BOM + 包装要求',
    owner_role: 'sales',
    deadline_hint: 'T0 + 2天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '上传BOM表、包装要求文件',
    blocks: ['bulk_materials_confirmed'],
  },
  {
    step_key: 'bulk_materials_confirmed',
    name: '大货原辅料确认',
    owner_role: 'procurement',
    deadline_hint: '生产单完成 + 1天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '确认主面料款号/色号/克重、辅料清单、风险备注（高弹/浅色/大码）',
    blocks: ['procurement_order_placed'],
  },

  // ══ 阶段3：产前样（3）════════════════════════════════════════
  {
    step_key: 'pre_production_sample_ready',
    name: '产前样完成',
    owner_role: 'production',
    deadline_hint: 'ETD - 23天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '产前样照片（正面、反面、细节、标签位）',
    blocks: ['pre_production_sample_sent'],
  },
  {
    step_key: 'pre_production_sample_sent',
    name: '产前样寄出',
    owner_role: 'sales',
    deadline_hint: 'ETD - 21天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '快递单号截图',
    blocks: ['pre_production_sample_approved'],
  },
  {
    step_key: 'pre_production_sample_approved',
    name: '客户确认产前样',
    owner_role: 'sales',
    deadline_hint: 'ETD - 18天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '客户确认邮件 / 系统审批截图（⚠️ 未确认禁止开裁）',
    blocks: ['production_kickoff'],
  },

  // ══ 阶段4：采购与生产（4）════════════════════════════════════
  {
    step_key: 'procurement_order_placed',
    name: '采购下单 + ETA',
    owner_role: 'procurement',
    deadline_hint: 'T0 + 2天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '采购订单截图 + 供应商预计到货日期（ETA）',
    blocks: ['materials_received_inspected'],
    can_delay: true,
  },
  {
    step_key: 'materials_received_inspected',
    name: '物料到位验收',
    owner_role: 'logistics',
    deadline_hint: '到货日 + 1天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '验收记录 + 问题清单（如有）',
    blocks: ['production_kickoff'],
  },
  {
    step_key: 'production_kickoff',
    name: '生产排期 + 开裁',
    owner_role: 'production',
    deadline_hint: '物料验收后1天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '排产单 + 开裁记录照片',
    blocks: ['pre_production_meeting'],
  },
  {
    step_key: 'pre_production_meeting',
    name: '产前会（生产+业务+QC）',
    owner_role: 'production',
    deadline_hint: '开裁前1天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '产前会会议记录 + 签到表照片',
    blocks: ['mid_qc_check'],
  },

  // ══ 阶段5：过程控制（2）══════════════════════════════════════
  {
    step_key: 'mid_qc_check',
    name: '中查',
    owner_role: 'qc',
    deadline_hint: '生产中期',
    is_critical: false,
    evidence_required: true,
    evidence_note: '中查报告（抽检比例 + 问题清单 + 整改要求）',
    blocks: ['final_qc_check'],
    can_delay: true,
  },
  {
    step_key: 'final_qc_check',
    name: '尾查',
    owner_role: 'qc',
    deadline_hint: 'ETD - 7天（包装前）',
    is_critical: true,
    evidence_required: true,
    evidence_note: 'AQL检验报告 + 合格证书（⚠️ 未通过禁止包装）',
    blocks: ['packing_method_confirmed'],
    can_delay: true,
  },

  // ══ 阶段6：出货控制（3）══════════════════════════════════════
  {
    step_key: 'packing_method_confirmed',
    name: '包装方式业务确认',
    owner_role: 'sales',
    deadline_hint: '包装当天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '现场包装方式照片（折叠方式 + 尺码条位置 + 唛头位）',
    blocks: ['inspection_release'],
  },
  {
    step_key: 'inspection_release',
    name: '验货 / 放行',
    owner_role: 'qc',
    deadline_hint: 'ETD - 7天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '第三方验货报告 / 内部放行单',
    blocks: ['shipping_sample_send', 'booking_done'],
  },
  {
    step_key: 'shipping_sample_send',
    name: '船样确认',
    owner_role: 'sales',
    deadline_hint: 'ETD - 7天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '客户船样确认邮件（⚠️ 未确认禁止订舱）',
    blocks: ['booking_done'],
    shipping_sample_only: true,
  },

  // ══ 阶段7：物流收款（3）══════════════════════════════════════
  {
    step_key: 'booking_done',
    name: '订舱',
    owner_role: 'logistics',
    deadline_hint: 'ETD - 5天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '订舱确认单（Booking Confirmation）',
    blocks: ['customs_export'],
  },
  {
    step_key: 'customs_export',
    name: '报关 + 出运',
    owner_role: 'logistics',
    deadline_hint: 'ETD - 3天',
    is_critical: true,
    evidence_required: true,
    evidence_note: '提单（B/L）+ 报关单',
    blocks: ['payment_received'],
  },
  {
    step_key: 'payment_received',
    name: '收款确认',
    owner_role: 'finance',
    deadline_hint: '按付款条款',
    is_critical: true,
    evidence_required: true,
    evidence_note: '银行到账水单截图',
    blocks: [],
  },
];

/** 兼容旧代码 */
export const MILESTONE_TEMPLATE_V1 = MILESTONE_TEMPLATE_FINAL;
export const MILESTONE_TEMPLATE_V2 = MILESTONE_TEMPLATE_FINAL;
export const MILESTONE_TEMPLATE_V3 = MILESTONE_TEMPLATE_FINAL;

export function getApplicableMilestones(
  orderType: 'sample' | 'bulk' | 'repeat' = 'bulk',
  shippingSampleRequired = false
): MilestoneTemplate[] {
  return MILESTONE_TEMPLATE_FINAL.filter(m => {
    if (m.shipping_sample_only && !shippingSampleRequired) return false;
    return true;
  });
}

export function getDependencyMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const m of MILESTONE_TEMPLATE_FINAL) {
    if (m.blocks.length > 0) map[m.step_key] = m.blocks;
  }
  return map;
}
