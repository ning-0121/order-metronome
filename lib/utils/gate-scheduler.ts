/**
 * Gate Scheduler - Gate 时间计算和依赖检查
 * 
 * 职责：
 * 1. 根据目标日期和 Gate 模板计算每个 Gate 的 planned_at 和 due_at
 * 2. 处理 Gate 依赖关系
 * 3. 确保 required Gate 未通过前，后续 Gate 不可进入"进行中"
 */

import { GATE_TEMPLATE_V2, adjustGateTiming, type GateTemplate } from '@/lib/domain/gateTemplate';
import { subtractWorkingDays, ensureBusinessDay } from './date';

export interface GateSchedule {
  gate_key: string;
  name: string;
  stage: string;
  owner_role: string;
  required: boolean;
  depends_on: string[];
  planned_at: Date;
  due_at: Date;
  is_critical: boolean;
  evidence_required: boolean;
  initial_status: 'pending' | 'in_progress'; // 初始状态
}

/**
 * 计算所有 Gate 的时间表
 */
export function calculateGateSchedule(params: {
  createdAt: Date;
  incoterm: 'FOB' | 'DDP';
  orderType: 'sample' | 'bulk';
  packagingType: 'standard' | 'custom';
  etd?: string | null;
  warehouseDueDate?: string | null;
}): GateSchedule[] {
  const { createdAt, incoterm, orderType, packagingType, etd, warehouseDueDate } = params;

  // 确定目标日期（锚点）
  const anchorStr = incoterm === 'FOB' ? etd : warehouseDueDate;
  if (!anchorStr) {
    throw new Error('Missing anchor date (ETD for FOB or Warehouse Due Date for DDP)');
  }

  const anchor = ensureBusinessDay(new Date(anchorStr + 'T00:00:00'));

  // 计算每个 Gate 的时间
  const schedules: GateSchedule[] = [];

  // 第一遍：计算所有 Gate 的时间
  for (const gate of GATE_TEMPLATE_V2) {
    const adjustedDays = adjustGateTiming(gate, incoterm, orderType, packagingType);
    // adjustedDays 是负数（表示提前多少天），需要转换为正数传给 subtractWorkingDays
    const daysBeforeAnchor = Math.abs(adjustedDays);
    const dueDate = subtractWorkingDays(anchor, daysBeforeAnchor);
    const plannedDate = subtractWorkingDays(dueDate, 1); // planned_at 是 due_at 前1个工作日

    // 初始状态：只有第一个 Gate（po_confirmed）是 in_progress
    const initialStatus: 'pending' | 'in_progress' = 
      gate.gate_key === 'po_confirmed' ? 'in_progress' : 'pending';

    schedules.push({
      gate_key: gate.gate_key,
      name: gate.name,
      stage: gate.stage,
      owner_role: gate.owner_role,
      required: gate.required,
      depends_on: gate.depends_on || [],
      planned_at: ensureBusinessDay(plannedDate),
      due_at: ensureBusinessDay(dueDate),
      is_critical: gate.is_critical,
      evidence_required: gate.evidence_required,
      initial_status: initialStatus,
    });
  }

  return schedules;
}

/**
 * 检查 Gate 是否可以进入"进行中"状态
 * 
 * 规则：
 * - 如果 Gate 有依赖（depends_on），所有 required 依赖必须已完成
 * - 如果 Gate 是 required，必须通过才能继续后续 required Gate
 */
export function canGateStart(
  gateKey: string,
  schedules: GateSchedule[],
  completedGates: Set<string>
): { canStart: boolean; reason?: string } {
  const gate = schedules.find(g => g.gate_key === gateKey);
  if (!gate) {
    return { canStart: false, reason: 'Gate not found' };
  }

  // 检查依赖的 required Gate 是否已完成
  for (const depKey of gate.depends_on) {
    const depGate = schedules.find(g => g.gate_key === depKey);
    if (depGate && depGate.required) {
      if (!completedGates.has(depKey)) {
        return {
          canStart: false,
          reason: `依赖的强制控制点"${depGate.name}"尚未完成`,
        };
      }
    }
  }

  return { canStart: true };
}

/**
 * 获取下一个可以开始的 Gate
 */
export function getNextAvailableGate(
  schedules: GateSchedule[],
  completedGates: Set<string>,
  currentStatus: Map<string, string>
): GateSchedule | null {
  for (const gate of schedules) {
    // 跳过已完成的
    if (completedGates.has(gate.gate_key)) {
      continue;
    }

    // 跳过已在进行中的
    if (currentStatus.get(gate.gate_key) === 'in_progress') {
      continue;
    }

    // 检查是否可以开始
    const { canStart } = canGateStart(gate.gate_key, schedules, completedGates);
    if (canStart) {
      return gate;
    }
  }

  return null;
}
