/**
 * QIMO OS — Order Intake Router v1（订单入口收敛层）
 *
 * 所有订单创建入口的唯一分发器：PO Path（新主路径）/ Legacy Path（保留）。
 *   OrderIntakeRouter(input) → IntakeDecision
 *
 * 铁律：
 *   - Order 是 RESULT，不是 source；PO 是订单创建的 truth binding。
 *   - Router 只 dispatch，不执行业务逻辑、不写库、不重算。
 *   - PO Path 准入由 OSDecisionKernel 判定（唯一决策脑）；Router 只据其裁决分流。
 *   - Legacy Path 永远保留，不被新系统门控（手填流不因新链失效）。
 * fail-closed：PO 引用缺失 / Kernel 拒绝 → BLOCKED。
 */

import { OSDecisionKernel } from '@/lib/os/kernel';

export type IntakeSource = 'po' | 'manual';

export interface IntakeInput {
  source: IntakeSource;
  user: { id: string; email: string; roles: string[] };
  /** PO Path 需带绑定引用 */
  po?: { customerPoId?: string; quoteId?: string };
}

export type IntakeMode = 'PO' | 'LEGACY' | 'BLOCKED';

export interface IntakeDecision {
  mode: IntakeMode;
  handler: string; // 'from-po' | 'legacy-manual' | 'blocked'
  reason: string;
  allow: boolean;
}

export function OrderIntakeRouter(input: IntakeInput): IntakeDecision {
  // Legacy Path 永远可用（保留，不门控）
  if (input.source === 'manual') {
    return { mode: 'LEGACY', handler: 'legacy-manual', reason: 'manual_intake', allow: true };
  }

  // PO Path：必须带绑定引用
  if (!input.po?.customerPoId) {
    return { mode: 'BLOCKED', handler: 'blocked', reason: 'po_ref_missing', allow: false };
  }

  // 准入交 Kernel（唯一决策脑）—— 是否可进订单系统
  const decision = OSDecisionKernel({
    user: input.user,
    action: { type: 'ENTER_SYSTEM', targetSystem: 'order' },
  });
  if (!decision.allow) {
    return { mode: 'BLOCKED', handler: 'blocked', reason: `kernel_denied:${decision.reason}`, allow: false };
  }

  return { mode: 'PO', handler: 'from-po', reason: 'po_intake', allow: true };
}
