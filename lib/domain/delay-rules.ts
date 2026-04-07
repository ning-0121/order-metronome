/**
 * 延期规则引擎 — 按外贸业务最佳实践设计
 *
 * 核心原则：
 * 1. 客户原因 → 顺延交期，所有下游节点同步后移
 * 2. 不可抗力 → 必须客户书面同意，才能顺延
 * 3. 内部/供应商原因 → 不能改交期，压缩下游窗口，超限需升级
 * 4. 不同节点的最大可延天数不同（越靠近出货越严格）
 */

export type DelayCategory =
  | 'customer'       // 客户原因（改款、未确认样品、未付款、未验货等）
  | 'supplier'       // 供应商原因（面料辅料延迟）
  | 'internal'       // 内部原因（排期、返工、个人）
  | 'force_majeure'; // 不可抗力（疫情、天气、罢工）

export interface DelayCategoryInfo {
  label: string;
  emoji: string;
  description: string;
  impactsFinalDeliveryDate: boolean; // 是否影响最终交期
  requiresCustomerApproval: boolean; // 是否必须客户书面同意
  color: string; // UI 颜色
}

export const DELAY_CATEGORIES: Record<DelayCategory, DelayCategoryInfo> = {
  customer: {
    label: '客户原因',
    emoji: '👤',
    description: '客户未确认样品 / 改款 / 改色 / 改尺码 / 未付款 / 延期验货 / 未提供必要资料',
    impactsFinalDeliveryDate: true,
    requiresCustomerApproval: false, // 客户自己的原因，不需要重新确认
    color: 'blue',
  },
  supplier: {
    label: '供应商原因',
    emoji: '🏭',
    description: '面料供应商延迟 / 辅料供应商延迟 / 原料品质不达标',
    impactsFinalDeliveryDate: false, // 先尝试压缩下游，超限才能提升
    requiresCustomerApproval: false,
    color: 'amber',
  },
  internal: {
    label: '内部原因',
    emoji: '🏢',
    description: '工厂排期 / 品质返工 / 生产设备故障 / 员工能力问题 / 管理疏漏',
    impactsFinalDeliveryDate: false, // 内部问题不能影响客户交期
    requiresCustomerApproval: false,
    color: 'red',
  },
  force_majeure: {
    label: '不可抗力',
    emoji: '⚡',
    description: '疫情 / 自然灾害 / 罢工 / 港口封锁 / 法规变化',
    impactsFinalDeliveryDate: true,
    requiresCustomerApproval: true, // 必须客户书面同意
    color: 'purple',
  },
};

/**
 * 每个节点的最大允许延期天数（内部/供应商原因使用）
 *
 * 设计原则：
 * - 越靠近出货，允许的延期越少
 * - 关键卡点给更多空间
 * - 出运节点基本不能延
 */
export const NODE_MAX_DELAY_DAYS: Record<string, number> = {
  // 阶段1：订单评审（相对灵活）
  po_confirmed: 3,
  finance_approval: 2,
  order_kickoff_meeting: 1,
  production_order_upload: 3,

  // 阶段2：预评估（关键卡点）
  order_docs_bom_complete: 5,
  bulk_materials_confirmed: 3,

  // 阶段3：工厂匹配 & 产前样（风险高）
  processing_fee_confirmed: 2,
  factory_confirmed: 5,
  pre_production_sample_ready: 7,
  pre_production_sample_sent: 2,
  pre_production_sample_approved: 10, // 等客户确认，容易延迟

  // 阶段4：采购与生产（硬性限制）
  procurement_order_placed: 3,
  materials_received_inspected: 5,
  production_kickoff: 3, // 开裁一旦错过很难追
  pre_production_meeting: 1,

  // 阶段5：过程控制（压缩空间小）
  mid_qc_check: 2,
  final_qc_check: 2,

  // 阶段6：出货控制（基本不能延）
  packing_method_confirmed: 1,
  factory_completion: 2, // 延了就赶不上船
  inspection_release: 1,
  shipping_sample_send: 2,

  // 阶段7：物流收款（绝对死线）
  booking_done: 1,
  customs_export: 0, // 报关时间基本固定
  finance_shipment_approval: 1,
  shipment_execute: 0, // 船期固定
  payment_received: 30, // 付款可以延
};

export interface DelayValidationResult {
  allowed: boolean;
  reason: string;
  suggestedMaxDate?: string; // ISO date
  mustCompressDownstream: boolean; // 是否必须压缩下游
  willPushFinalDeliveryDate: boolean; // 是否会推迟最终交期
}

/**
 * 验证延期申请是否允许
 */
export function validateDelayRequest(params: {
  stepKey: string;
  category: DelayCategory;
  currentDueAt: string;
  proposedDueAt: string;
  downstreamEarliestDue?: string; // 下游最早截止日（用于判断压缩空间）
}): DelayValidationResult {
  const { stepKey, category, currentDueAt, proposedDueAt } = params;
  const categoryInfo = DELAY_CATEGORIES[category];

  const currentDate = new Date(currentDueAt);
  const proposedDate = new Date(proposedDueAt);
  const delayDays = Math.ceil((proposedDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24));

  // 基础验证
  if (delayDays <= 0) {
    return {
      allowed: false,
      reason: '新日期必须晚于原截止日期',
      mustCompressDownstream: false,
      willPushFinalDeliveryDate: false,
    };
  }

  // 客户原因 / 不可抗力 → 允许任意天数，顺延交期
  if (categoryInfo.impactsFinalDeliveryDate) {
    return {
      allowed: true,
      reason: category === 'customer'
        ? `客户原因延期 ${delayDays} 天，将同步后移所有下游节点和最终交期`
        : `不可抗力延期 ${delayDays} 天，需客户书面同意后推迟交期`,
      mustCompressDownstream: false,
      willPushFinalDeliveryDate: true,
    };
  }

  // 内部/供应商原因 → 检查最大允许天数
  const maxAllowed = NODE_MAX_DELAY_DAYS[stepKey];
  if (maxAllowed === undefined) {
    return {
      allowed: true,
      reason: `此节点未设定最大延期天数，建议谨慎操作`,
      mustCompressDownstream: true,
      willPushFinalDeliveryDate: false,
    };
  }

  if (maxAllowed === 0) {
    return {
      allowed: false,
      reason: `【${stepKey}】属于硬性死线节点，${categoryInfo.label}不允许延期。如确实无法按时完成，请联系客户协商（选择"客户原因"或"不可抗力"）`,
      mustCompressDownstream: false,
      willPushFinalDeliveryDate: false,
    };
  }

  if (delayDays > maxAllowed) {
    const maxDate = new Date(currentDate.getTime() + maxAllowed * 24 * 60 * 60 * 1000);
    return {
      allowed: false,
      reason: `${categoryInfo.label}最多允许延期 ${maxAllowed} 天（到 ${maxDate.toISOString().slice(0, 10)}）。申请了 ${delayDays} 天超出限制。\n\n建议：\n1) 缩短延期天数到 ${maxAllowed} 天以内\n2) 想办法加快后续节点进度\n3) 如果必须延更久，请与客户沟通改为"客户原因"`,
      suggestedMaxDate: maxDate.toISOString(),
      mustCompressDownstream: true,
      willPushFinalDeliveryDate: false,
    };
  }

  return {
    allowed: true,
    reason: `${categoryInfo.label}延期 ${delayDays} 天（不超过最大限制 ${maxAllowed} 天）。交期不变，下游节点窗口将被压缩 ${delayDays} 天，需要加快进度`,
    mustCompressDownstream: true,
    willPushFinalDeliveryDate: false,
  };
}

/**
 * 计算内部原因延期后，下游节点的压缩空间
 * 返回每个下游节点的新 due_at（保持最终交期不变）
 */
export function calculateCompressedDownstream(
  currentMilestone: { id: string; step_key: string; due_at: string },
  downstreamMilestones: Array<{ id: string; step_key: string; due_at: string }>,
  newCurrentDueAt: string,
): Array<{ id: string; newDueAt: string; squeezeDays: number }> {
  // 下游节点的 due_at 不变（保持最终交期）
  // 但每个节点的"可用时间窗口"被压缩
  // 这里我们不改下游 due_at，只返回压缩信息用于告警
  const delayDays = Math.ceil(
    (new Date(newCurrentDueAt).getTime() - new Date(currentMilestone.due_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  return downstreamMilestones.map(m => ({
    id: m.id,
    newDueAt: m.due_at, // 不变
    squeezeDays: delayDays, // 压缩了多少天
  }));
}
