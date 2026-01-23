/**
 * Gate Generator - 动态生成 Gate 时间表
 * 
 * 职责：
 * 1. 根据订单特征筛选应该生成的 Gate
 * 2. 计算每个 Gate 的 planned_at 和 due_at
 * 3. 处理 Gate 依赖关系
 */

import {
  GATE_TEMPLATES,
  shouldGenerateGate,
  adjustGateOffset,
  resolveDependsOn,
  type GateTemplate,
  type OrderType,
  type PackagingType,
} from '@/lib/domain/gates';
import { subtractWorkingDays, ensureBusinessDay } from './date';

export interface GateSchedule {
  gate_key: string;
  name_cn: string;
  stage: string;
  owner_role: string;
  required: boolean;
  depends_on: string[];
  planned_at: Date;
  due_at: Date;
  is_critical: boolean;
  evidence_required: boolean;
  initial_status: 'pending' | 'in_progress';
}

export interface OrderParams {
  createdAt: Date;
  incoterm: 'FOB' | 'DDP';
  order_type: OrderType;
  packaging_type: PackagingType;
  needs_pp_sample?: boolean;
  needs_ship_sample?: boolean;
  needs_qc?: boolean;
  etd?: string | null;
  warehouse_due_date?: string | null;
}

/**
 * 生成 Gate 时间表
 */
export function generateGateSchedule(params: OrderParams): GateSchedule[] {
  const {
    createdAt,
    incoterm,
    order_type,
    packaging_type,
    needs_pp_sample = true,
    needs_ship_sample = false,
    needs_qc = true,
    etd,
    warehouse_due_date,
  } = params;

  // 确定锚点日期
  let anchorDate: Date;
  if (incoterm === 'FOB') {
    if (!etd) {
      throw new Error('FOB 订单必须提供 ETD');
    }
    anchorDate = ensureBusinessDay(new Date(etd + 'T00:00:00'));
  } else {
    if (!warehouse_due_date) {
      throw new Error('DDP 订单必须提供 Warehouse Due Date');
    }
    anchorDate = ensureBusinessDay(new Date(warehouse_due_date + 'T00:00:00'));
  }

  // 第一步：筛选应该生成的 Gate
  const order = {
    order_type,
    packaging_type,
    needs_pp_sample,
    needs_ship_sample,
    needs_qc,
  };

  const filteredGates = GATE_TEMPLATES.filter(gate => shouldGenerateGate(gate, order));
  const generatedGateKeys = new Set(filteredGates.map(g => g.gate_key));

  // 第二步：计算每个 Gate 的时间
  const schedules: GateSchedule[] = [];

  for (const gate of filteredGates) {
    // 调整 offset_days
    const adjustedOffset = adjustGateOffset(gate, {
      order_type,
      packaging_type,
      incoterm,
    });

    // 确定锚点
    let anchor: Date;
    if (gate.anchor === 'created_at') {
      anchor = createdAt;
    } else if (gate.anchor === 'etd') {
      anchor = anchorDate;
    } else {
      anchor = anchorDate; // warehouse_due_date
    }

    // 计算 due_at
    const daysBeforeAnchor = Math.abs(adjustedOffset);
    const dueDate = subtractWorkingDays(anchor, daysBeforeAnchor);

    // 计算 planned_at（due_at 前 1 个工作日）
    const plannedDate = subtractWorkingDays(dueDate, 1);

    // 解析依赖
    const resolvedDependsOn = resolveDependsOn(gate, generatedGateKeys);

    // 初始状态：只有第一个 Gate（po_confirmed）是 in_progress
    const initialStatus: 'pending' | 'in_progress' =
      gate.gate_key === 'po_confirmed' ? 'in_progress' : 'pending';

    schedules.push({
      gate_key: gate.gate_key,
      name_cn: gate.name_cn,
      stage: gate.stage,
      owner_role: gate.owner_role,
      required: gate.required,
      depends_on: resolvedDependsOn,
      planned_at: ensureBusinessDay(plannedDate),
      due_at: ensureBusinessDay(dueDate),
      is_critical: gate.is_critical,
      evidence_required: gate.evidence_required,
      initial_status: initialStatus,
    });
  }

  return schedules;
}
