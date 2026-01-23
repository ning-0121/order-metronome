/**
 * 外贸托底级 Gate 模板系统
 * 
 * 设计原则：
 * 1. 卡风险，而不是走流程
 * 2. 按订单特征动态生成 Gate
 * 3. 支持条件 Gate（needs_pp_sample, needs_ship_sample, needs_qc）
 * 4. 不同订单类型（Sample/Bulk/Repeat）生成不同 Gate
 */

export type GateStage = '订单启动' | '原辅料' | '产前样' | '生产' | 'QC' | '出货';

export type OrderType = 'sample' | 'bulk' | 'repeat';
export type PackagingType = 'standard' | 'custom';

export interface GateCondition {
  order_type?: OrderType[]; // 哪些订单类型需要此 Gate
  needs_pp_sample?: boolean; // 是否需要产前样
  needs_ship_sample?: boolean; // 是否需要船样
  needs_qc?: boolean; // 是否需要 QC
  packaging_type?: PackagingType[]; // 哪些包装类型需要此 Gate
}

export interface GateTemplate {
  gate_key: string;
  name_cn: string;
  stage: GateStage;
  owner_role: 'sales' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics' | 'admin';
  required: boolean;
  offset_days: number; // 相对 anchor 的天数（负数表示提前）
  anchor: 'created_at' | 'etd' | 'warehouse_due_date'; // 锚点日期
  depends_on: string[]; // 依赖的 gate_key 列表
  is_critical: boolean;
  evidence_required: boolean;
  condition?: GateCondition; // 条件：满足条件才生成此 Gate
}

/**
 * V1 骨干模板（18个关键控制点）
 * 流程：PO->Finance->Docs->Procurement->QC->PPS->Production->QC->Packaging->Booking->Shipment->Payment
 */
export const GATE_TEMPLATES_V1: GateTemplate[] = [
  // 1. PO确认
  {
    gate_key: 'po_confirmed',
    name_cn: 'PO确认',
    stage: '订单启动',
    owner_role: 'sales',
    required: true,
    offset_days: 0,
    anchor: 'created_at',
    depends_on: [],
    is_critical: true,
    evidence_required: false,
  },
  // 2. 财务审核
  {
    gate_key: 'finance_approval',
    name_cn: '财务审核',
    stage: '订单启动',
    owner_role: 'finance',
    required: true,
    offset_days: 2, // T0+2d
    anchor: 'created_at',
    depends_on: ['po_confirmed'],
    is_critical: true,
    evidence_required: false,
  },
  // 3. 订单资料齐全
  {
    gate_key: 'order_docs_complete',
    name_cn: '订单资料齐全',
    stage: '订单启动',
    owner_role: 'sales',
    required: true,
    offset_days: 3, // T0+3d
    anchor: 'created_at',
    depends_on: ['po_confirmed'],
    is_critical: true,
    evidence_required: false,
  },
  // 4. 原辅料采购
  {
    gate_key: 'raw_materials_procurement',
    name_cn: '原辅料采购',
    stage: '原辅料',
    owner_role: 'procurement',
    required: true,
    offset_days: -35, // 相对锚点提前35天
    anchor: 'etd',
    depends_on: ['finance_approval', 'order_docs_complete'],
    is_critical: true,
    evidence_required: true,
  },
  // 5. 原辅料到位
  {
    gate_key: 'raw_materials_arrival',
    name_cn: '原辅料到位',
    stage: '原辅料',
    owner_role: 'procurement',
    required: true,
    offset_days: -30,
    anchor: 'etd',
    depends_on: ['raw_materials_procurement'],
    is_critical: true,
    evidence_required: true,
  },
  // 6. 原辅料验收（QC）
  {
    gate_key: 'raw_materials_inspection',
    name_cn: '原辅料验收',
    stage: '原辅料',
    owner_role: 'qc',
    required: true,
    offset_days: -28,
    anchor: 'etd',
    depends_on: ['raw_materials_arrival'],
    is_critical: true,
    evidence_required: true,
  },
  // 7. 产前样完成（PPS）
  {
    gate_key: 'pp_sample_production',
    name_cn: '产前样完成',
    stage: '产前样',
    owner_role: 'production',
    required: true,
    offset_days: -25,
    anchor: 'etd',
    depends_on: ['raw_materials_inspection'],
    is_critical: true,
    evidence_required: true,
    condition: {
      needs_pp_sample: true,
    },
  },
  // 8. 产前样寄出
  {
    gate_key: 'pp_sample_sent',
    name_cn: '产前样寄出',
    stage: '产前样',
    owner_role: 'production',
    required: true,
    offset_days: -24,
    anchor: 'etd',
    depends_on: ['pp_sample_production'],
    is_critical: true,
    evidence_required: true,
    condition: {
      needs_pp_sample: true,
    },
  },
  // 9. 产前样确认
  {
    gate_key: 'pp_sample_confirmed',
    name_cn: '产前样确认',
    stage: '产前样',
    owner_role: 'sales',
    required: true,
    offset_days: -20,
    anchor: 'etd',
    depends_on: ['pp_sample_sent'],
    is_critical: true,
    evidence_required: true,
    condition: {
      needs_pp_sample: true,
    },
  },
  // 10. 工厂上线（Production）
  {
    gate_key: 'production_start',
    name_cn: '工厂上线',
    stage: '生产',
    owner_role: 'production',
    required: true,
    offset_days: -18,
    anchor: 'etd',
    depends_on: ['pp_sample_confirmed', 'raw_materials_inspection'],
    is_critical: true,
    evidence_required: true,
  },
  // 11. 中查（QC）
  {
    gate_key: 'mid_inspection',
    name_cn: '中查',
    stage: '生产',
    owner_role: 'qc',
    required: false,
    offset_days: -12,
    anchor: 'etd',
    depends_on: ['production_start'],
    is_critical: false,
    evidence_required: true,
  },
  // 12. 尾查（QC）
  {
    gate_key: 'final_inspection',
    name_cn: '尾查',
    stage: '生产',
    owner_role: 'qc',
    required: true,
    offset_days: -7,
    anchor: 'etd',
    depends_on: ['mid_inspection', 'production_start'],
    is_critical: true,
    evidence_required: true,
  },
  // 13. 包装辅料到位（Packaging）
  {
    gate_key: 'packaging_materials_arrival',
    name_cn: '包装辅料到位',
    stage: '生产',
    owner_role: 'procurement',
    required: true,
    offset_days: -10, // offline-7d = -10 (假设offline是-3d)
    anchor: 'etd',
    depends_on: ['production_start'],
    is_critical: true,
    evidence_required: true,
  },
  // 14. QC验货预约（QC）
  {
    gate_key: 'qc_appointment',
    name_cn: 'QC验货预约',
    stage: 'QC',
    owner_role: 'qc',
    required: true,
    offset_days: -5,
    anchor: 'etd',
    depends_on: ['final_inspection'],
    is_critical: true,
    evidence_required: true,
    condition: {
      needs_qc: true,
    },
  },
  // 15. QC验货完成
  {
    gate_key: 'qc_inspection_complete',
    name_cn: 'QC验货完成',
    stage: 'QC',
    owner_role: 'qc',
    required: true,
    offset_days: -3,
    anchor: 'etd',
    depends_on: ['qc_appointment'],
    is_critical: true,
    evidence_required: true,
    condition: {
      needs_qc: true,
    },
  },
  // 16. 订舱完成（Booking）
  {
    gate_key: 'booking',
    name_cn: '订舱完成',
    stage: '出货',
    owner_role: 'logistics',
    required: true,
    offset_days: -7, // cut-off-7d (FOB: -7, DDP: -21)
    anchor: 'etd',
    depends_on: ['qc_inspection_complete', 'final_inspection'],
    is_critical: true,
    evidence_required: true,
  },
  // 17. 出货完成（Shipment）
  {
    gate_key: 'shipment',
    name_cn: '出货完成',
    stage: '出货',
    owner_role: 'logistics',
    required: true,
    offset_days: 0,
    anchor: 'etd',
    depends_on: ['booking'],
    is_critical: true,
    evidence_required: true,
  },
  // 18. 付款完成（Payment）
  {
    gate_key: 'payment_complete',
    name_cn: '付款完成',
    stage: '出货',
    owner_role: 'finance',
    required: true,
    offset_days: 7, // 出货后7天
    anchor: 'etd',
    depends_on: ['shipment'],
    is_critical: true,
    evidence_required: true,
  },
];

/**
 * 外贸托底级 Gate 模板（18-20个关键控制点）
 * @deprecated Use GATE_TEMPLATES_V1 for V1 backbone
 */
export const GATE_TEMPLATES: GateTemplate[] = GATE_TEMPLATES_V1;

/**
 * 检查 Gate 是否应该生成（根据订单特征）
 */
export function shouldGenerateGate(
  gate: GateTemplate,
  order: {
    order_type: OrderType;
    packaging_type: PackagingType;
    needs_pp_sample?: boolean;
    needs_ship_sample?: boolean;
    needs_qc?: boolean;
  }
): boolean {
  // 如果没有条件，默认生成
  if (!gate.condition) {
    return true;
  }

  const cond = gate.condition;

  // 检查订单类型
  if (cond.order_type && !cond.order_type.includes(order.order_type)) {
    return false;
  }

  // 检查产前样需求
  if (cond.needs_pp_sample !== undefined) {
    if (cond.needs_pp_sample && !order.needs_pp_sample) {
      return false;
    }
    if (!cond.needs_pp_sample && order.needs_pp_sample) {
      return false;
    }
  }

  // 检查船样需求
  if (cond.needs_ship_sample !== undefined) {
    if (cond.needs_ship_sample && !order.needs_ship_sample) {
      return false;
    }
    if (!cond.needs_ship_sample && order.needs_ship_sample) {
      return false;
    }
  }

  // 检查 QC 需求
  if (cond.needs_qc !== undefined) {
    if (cond.needs_qc && !order.needs_qc) {
      return false;
    }
    if (!cond.needs_qc && order.needs_qc) {
      return false;
    }
  }

  // 检查包装类型
  if (cond.packaging_type && !cond.packaging_type.includes(order.packaging_type)) {
    return false;
  }

  return true;
}

/**
 * 调整 Gate 的 offset_days（根据订单特征）
 */
export function adjustGateOffset(
  gate: GateTemplate,
  order: {
    order_type: OrderType;
    packaging_type: PackagingType;
    incoterm: 'FOB' | 'DDP';
  }
): number {
  let offset = gate.offset_days;

  // 订舱时间根据 incoterm 调整
  if (gate.gate_key === 'booking') {
    offset = order.incoterm === 'FOB' ? -7 : -21;
  }

  // 包装辅料到位时间根据包装类型调整
  if (gate.gate_key === 'packaging_materials_arrival') {
    if (order.packaging_type === 'custom') {
      offset = -15; // Custom 包装需要提前到 -15
    }
  }

  // 样品订单时间压缩（压缩 50%）
  if (order.order_type === 'sample') {
    offset = Math.ceil(offset * 0.5);
  }

  return offset;
}

/**
 * 解析 depends_on（处理条件依赖）
 */
export function resolveDependsOn(
  gate: GateTemplate,
  generatedGates: Set<string>
): string[] {
  const resolved: string[] = [];

  for (const depKey of gate.depends_on) {
    // 如果依赖的 Gate 已生成，则添加
    if (generatedGates.has(depKey)) {
      resolved.push(depKey);
    }
  }

  // 特殊处理：production_start 的依赖
  if (gate.gate_key === 'production_start') {
    // 如果有产前样确认，依赖产前样确认；否则依赖原辅料验收
    if (generatedGates.has('pp_sample_confirmed')) {
      resolved.push('pp_sample_confirmed');
    } else {
      resolved.push('raw_materials_inspection');
    }
  }

  // 特殊处理：booking 的依赖
  if (gate.gate_key === 'booking') {
    // 如果有 QC 验货完成，依赖 QC；否则依赖尾查
    if (generatedGates.has('qc_inspection_complete')) {
      resolved.push('qc_inspection_complete');
    } else {
      resolved.push('final_inspection');
    }
  }

  return resolved;
}
