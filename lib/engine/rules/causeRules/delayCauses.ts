/**
 * 延期类根因规则
 */

import type { CauseRule, CauseEvaluation } from '@/lib/engine/types';

/**
 * DELAY_FACTORY_MATERIAL
 * 触发：materials_received_inspected 节点
 *   - 实际完成日比截止日晚 >3 天，或
 *   - 未完成且已逾期 >3 天
 */
const delayFactoryMaterial: CauseRule = {
  code: 'DELAY_FACTORY_MATERIAL',
  domain: 'delay',
  type: 'MATERIAL_DELAY',
  title: '面料/辅料到货延误超过 3 天',
  evaluate: (ctx): CauseEvaluation | null => {
    const node = ctx.milestones.find((m: any) => m.step_key === 'materials_received_inspected');
    if (!node) return null;
    if (!node.due_at) return null;

    const status = String(node.status || '').toLowerCase();
    const isDone = status === 'done' || status === '已完成';
    const due = new Date(node.due_at as string);
    const now = new Date();

    let delayDays = 0;
    let mode: 'completed_late' | 'still_overdue' | null = null;

    if (isDone && node.actual_at) {
      const actual = new Date(node.actual_at as string);
      delayDays = Math.ceil((actual.getTime() - due.getTime()) / 86400000);
      if (delayDays > 3) mode = 'completed_late';
    } else if (!isDone) {
      delayDays = Math.ceil((now.getTime() - due.getTime()) / 86400000);
      if (delayDays > 3) mode = 'still_overdue';
    }

    if (!mode) return null;

    const severity: 'high' | 'critical' = delayDays >= 10 ? 'critical' : 'high';

    return {
      matched: true,
      stage: 'A',
      severity,
      impact_days: delayDays,
      impact_cost: 0,
      responsible_role: 'procurement',
      evidence: {
        node_status: node.status,
        due_at: node.due_at,
        actual_at: node.actual_at,
        delay_days: delayDays,
        mode,
      },
      confidence: 0.92,
      description: mode === 'still_overdue'
        ? `面料到货节点已逾期 ${delayDays} 天仍未完成，可能影响开裁。建议采购确认到货时间，跟单评估排期影响。`
        : `面料到货比计划晚 ${delayDays} 天完成，已影响后续生产排期。建议跟单评估对工厂开工/出运的连锁影响。`,
    };
  },
};

export const delayCauseRules: CauseRule[] = [delayFactoryMaterial];
