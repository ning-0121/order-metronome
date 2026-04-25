/**
 * 确认链类根因规则
 */

import type { CauseRule, CauseEvaluation } from '@/lib/engine/types';

/**
 * CONFIRM_PACKAGING_LABEL_MISSING
 * 触发：包装/唛头未确认 + packing_method_confirmed 节点已逾期
 */
const confirmPackagingLabelMissing: CauseRule = {
  code: 'CONFIRM_PACKAGING_LABEL_MISSING',
  domain: 'confirmation',
  type: 'CONFIRMATION_MISSING',
  title: '包装/唛头未确认 — 包装节点已逾期',
  evaluate: (ctx): CauseEvaluation | null => {
    // 找 packaging_label 确认状态（兼容多种 module 命名）
    const packagingConfirmed = ctx.confirmations.some((c: any) => {
      const m = String(c.module || '').toLowerCase();
      return (
        (m === 'packaging_label' || m === 'packaging' || m === 'label')
        && (c.status === 'confirmed' || c.status === '已确认')
      );
    });
    if (packagingConfirmed) return null;

    // 检查 packing_method_confirmed 是否已逾期且未完成
    const packingNode = ctx.milestones.find((m: any) => m.step_key === 'packing_method_confirmed');
    if (!packingNode) return null;

    const status = String(packingNode.status || '').toLowerCase();
    if (status === 'done' || status === '已完成') return null;
    if (!packingNode.due_at) return null;

    const now = new Date();
    const due = new Date(packingNode.due_at as string);
    if (due >= now) return null;

    const overdueDays = Math.ceil((now.getTime() - due.getTime()) / 86400000);

    return {
      matched: true,
      stage: 'C',
      severity: overdueDays >= 7 ? 'critical' : 'high',
      impact_days: overdueDays,
      impact_cost: 0,
      responsible_role: 'sales',
      evidence: {
        packaging_label_status: ctx.confirmations
          .filter((c: any) => {
            const m = String(c.module || '').toLowerCase();
            return m === 'packaging_label' || m === 'packaging' || m === 'label';
          })
          .map((c: any) => ({ module: c.module, status: c.status })),
        packing_node_status: packingNode.status,
        packing_node_due_at: packingNode.due_at,
        overdue_days: overdueDays,
      },
      confidence: 0.9,
      description: `包装/唛头确认未完成，但「包装方式确认」节点已逾期 ${overdueDays} 天。建议业务尽快推动客户确认包装资料，否则将进一步阻塞尾查与出运。`,
    };
  },
};

export const confirmationCauseRules: CauseRule[] = [confirmPackagingLabelMissing];
