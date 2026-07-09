import { isActiveStatus } from '@/lib/domain/types';

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

