/**
 * 收款类根因规则
 */

import type { CauseRule, CauseEvaluation } from '@/lib/engine/types';

/**
 * PAYMENT_BLOCKING_PRODUCTION
 * 触发：定金未到 / payment_hold / allow_production=false 时，订单已开工或临近开工
 */
const paymentBlockingProduction: CauseRule = {
  code: 'PAYMENT_BLOCKING_PRODUCTION',
  domain: 'payment',
  type: 'PAYMENT_ISSUE',
  title: '付款未就绪即将进入大货生产',
  evaluate: (ctx): CauseEvaluation | null => {
    const fin = ctx.financials as any;
    if (!fin) return null;

    // TODO(SoT): deposit_status / balance_status are owned by Finance System.
    // OM-side values are legacy/cache signals only and must not be treated as
    // the source of truth. allow_production / payment_hold are OM-side override
    // controls and remain valid. See docs/system-layer.md.
    const blocked =
      fin.allow_production === false ||
      fin.payment_hold === true ||
      (fin.deposit_status && fin.deposit_status !== 'received' && fin.deposit_status !== 'waived');

    if (!blocked) return null;

    // 找 production_kickoff 节点
    const kickoff = ctx.milestones.find((m: any) => m.step_key === 'production_kickoff');
    if (!kickoff) return null;

    const status = String(kickoff.status || '').toLowerCase();
    const isInProgress = status === 'in_progress' || status === '进行中';
    const isDone = status === 'done' || status === '已完成';

    const due = kickoff.due_at ? new Date(kickoff.due_at as string) : null;
    const now = new Date();
    const daysToKickoff = due ? Math.ceil((due.getTime() - now.getTime()) / 86400000) : null;

    // 触发条件：开工节点已 in_progress / 已 done（仍未付款）/ 距开工 ≤ 5 天
    const matched =
      isDone ||
      isInProgress ||
      (daysToKickoff !== null && daysToKickoff <= 5);

    if (!matched) return null;

    const reasonText = fin.payment_hold === true
      ? '订单已被财务锁定（payment_hold=true）'
      : fin.allow_production === false
        ? '财务尚未放行生产（allow_production=false）'
        : `定金状态：${fin.deposit_status || '未知'}`;

    return {
      matched: true,
      stage: 'A',
      severity: 'critical',
      impact_days: daysToKickoff !== null && daysToKickoff < 0 ? Math.abs(daysToKickoff) : 0,
      impact_cost: 0,
      responsible_role: 'finance',
      evidence: {
        deposit_status: fin.deposit_status,
        balance_status: fin.balance_status,
        payment_hold: fin.payment_hold,
        allow_production: fin.allow_production,
        kickoff_status: kickoff.status,
        kickoff_due_at: kickoff.due_at,
        days_to_kickoff: daysToKickoff,
      },
      confidence: 0.95,
      description: `${reasonText}，但生产节点已临近或已启动。建议财务先催收定金或解除锁定，再放行生产。`,
    };
  },
};

export const paymentCauseRules: CauseRule[] = [paymentBlockingProduction];
