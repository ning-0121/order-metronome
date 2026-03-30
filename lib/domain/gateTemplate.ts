/**
 * Gate Template - 外贸托底级控制点模板
 * 
 * 设计原则：
 * 1. 卡风险，而不是走流程
 * 2. 每个 Gate 都是关键控制点
 * 3. 按阶段分组：订单合法性 / 原辅料 / 生产 / QC / 出货
 * 4. required Gate 未通过前，后续 Gate 不可进入"进行中"
 */

import type { OwnerRole } from './types';

export type GateStage = '订单合法性' | '原辅料' | '生产' | 'QC' | '出货';

export interface GateTemplate {
  gate_key: string;
  name: string;
  stage: GateStage;
  owner_role: OwnerRole;
  required: boolean; // 是否为强制 Gate（必须通过才能继续）
  depends_on?: string[]; // 依赖的 gate_key 列表（这些 Gate 必须已完成）
  days_before_target: number; // 相对目标日期的天数（负数表示提前）
  is_critical: boolean;
  evidence_required: boolean;
}

/**
 * 外贸托底级 Gate 模板（15-18个关键控制点）
 * 
 * 阶段划分：
 * 1. 订单合法性：PO确认、财务审核、订单资料齐全
 * 2. 原辅料：原辅料采购、到位、验收
 * 3. 生产：产前样完成、寄出、确认、工厂上线、中查、尾查、包装辅料到位
 * 4. QC：QC验货预约、QC验货完成
 * 5. 出货：订舱完成、出货完成
 */
export const GATE_TEMPLATE_V2: GateTemplate[] = [
  // =========================
  // 阶段 1：订单合法性
  // =========================
  {
    gate_key: 'po_confirmed',
    name: 'PO确认',
    stage: '订单合法性',
    owner_role: 'sales',
    required: true,
    depends_on: [],
    days_before_target: 0, // 订单创建时
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'finance_approval',
    name: '财务审核',
    stage: '订单合法性',
    owner_role: 'finance',
    required: true,
    depends_on: ['po_confirmed'],
    days_before_target: -2, // PO确认后2个工作日
    is_critical: true,
    evidence_required: false,
  },
  {
    gate_key: 'order_docs_complete',
    name: '订单资料齐全',
    stage: '订单合法性',
    owner_role: 'sales',
    required: true,
    depends_on: ['po_confirmed'],
    days_before_target: -3, // PO确认后3个工作日
    is_critical: true,
    evidence_required: true,
  },

  // =========================
  // 阶段 2：原辅料
  // =========================
  {
    gate_key: 'raw_materials_procurement',
    name: '原辅料采购',
    stage: '原辅料',
    owner_role: 'procurement',
    required: true,
    depends_on: ['finance_approval', 'order_docs_complete'],
    days_before_target: -25, // 根据订单类型调整
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'raw_materials_arrival',
    name: '原辅料到位',
    stage: '原辅料',
    owner_role: 'procurement',
    required: true,
    depends_on: ['raw_materials_procurement'],
    days_before_target: -20,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'raw_materials_inspection',
    name: '原辅料验收',
    stage: '原辅料',
    owner_role: 'qc',
    required: true,
    depends_on: ['raw_materials_arrival'],
    days_before_target: -19,
    is_critical: true,
    evidence_required: true,
  },

  // =========================
  // 阶段 3：生产
  // =========================
  {
    gate_key: 'pre_production_sample',
    name: '产前样完成',
    stage: '生产',
    owner_role: 'production',
    required: true,
    depends_on: ['raw_materials_inspection'],
    days_before_target: -18,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'pre_production_sample_sent',
    name: '产前样寄出',
    stage: '生产',
    owner_role: 'production',
    required: true,
    depends_on: ['pre_production_sample'],
    days_before_target: -17,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'pre_production_sample_confirmed',
    name: '产前样确认',
    stage: '生产',
    owner_role: 'sales',
    required: true,
    depends_on: ['pre_production_sample_sent'],
    days_before_target: -14,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'production_start',
    name: '工厂上线',
    stage: '生产',
    owner_role: 'production',
    required: true,
    depends_on: ['pre_production_sample_confirmed'],
    days_before_target: -12,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'mid_inspection',
    name: '中查',
    stage: '生产',
    owner_role: 'qc',
    required: false, // 非强制，但建议
    depends_on: ['production_start'],
    days_before_target: -7,
    is_critical: false,
    evidence_required: true,
  },
  {
    gate_key: 'packaging_materials_arrival',
    name: '包装辅料到位',
    stage: '生产',
    owner_role: 'procurement',
    required: true,
    depends_on: ['production_start'],
    days_before_target: -5,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'final_inspection',
    name: '尾查',
    stage: '生产',
    owner_role: 'qc',
    required: true,
    depends_on: ['mid_inspection', 'packaging_materials_arrival'],
    days_before_target: -3,
    is_critical: true,
    evidence_required: true,
  },

  // =========================
  // 阶段 4：QC
  // =========================
  {
    gate_key: 'qc_appointment',
    name: 'QC验货预约',
    stage: 'QC',
    owner_role: 'qc',
    required: true,
    depends_on: ['final_inspection'],
    days_before_target: -2,
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'qc_inspection_complete',
    name: 'QC验货完成',
    stage: 'QC',
    owner_role: 'qc',
    required: true,
    depends_on: ['qc_appointment'],
    days_before_target: -1,
    is_critical: true,
    evidence_required: true,
  },

  // =========================
  // 阶段 5：出货
  // =========================
  {
    gate_key: 'booking',
    name: '订舱完成',
    stage: '出货',
    owner_role: 'logistics',
    required: true,
    depends_on: ['qc_inspection_complete'],
    days_before_target: -7, // FOB: -7, DDP: -21
    is_critical: true,
    evidence_required: true,
  },
  {
    gate_key: 'shipment',
    name: '出货完成',
    stage: '出货',
    owner_role: 'logistics',
    required: true,
    depends_on: ['booking'],
    days_before_target: 0, // 目标日期（ETD 或 Warehouse Due Date）
    is_critical: true,
    evidence_required: true,
  },
];

/**
 * 根据订单类型和包装类型调整 Gate 时间
 */
export function adjustGateTiming(
  gate: GateTemplate,
  incoterm: 'FOB' | 'DDP',
  orderType: 'sample' | 'bulk',
  packagingType: 'standard' | 'custom'
): number {
  let days = gate.days_before_target;

  // 订舱时间根据 incoterm 调整
  if (gate.gate_key === 'booking') {
    days = incoterm === 'FOB' ? -7 : -21;
  }

  // 包装辅料到位时间根据包装类型调整
  if (gate.gate_key === 'packaging_materials_arrival') {
    if (packagingType === 'custom') {
      days -= 7; // 定制包装需要提前7天
    }
  }

  // 样品订单时间压缩
  if (orderType === 'sample') {
    // 样品订单时间压缩50%
    days = Math.ceil(days * 0.5);
  }

  return days;
}

/**
 * 按阶段分组 Gate
 */
export function groupGatesByStage(gates: GateTemplate[]): Record<GateStage, GateTemplate[]> {
  const grouped: Record<GateStage, GateTemplate[]> = {
    '订单合法性': [],
    '原辅料': [],
    '生产': [],
    'QC': [],
    '出货': [],
  };

  for (const gate of gates) {
    grouped[gate.stage].push(gate);
  }

  return grouped;
}
