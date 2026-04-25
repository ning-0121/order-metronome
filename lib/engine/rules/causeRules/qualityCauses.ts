/**
 * 质量类根因规则
 */

import type { CauseRule, CauseEvaluation } from '@/lib/engine/types';

/**
 * DELAY_QC_REWORK
 * 触发：production_reports 中 defect_rate > 5% 或 final_qc_check 节点 status=blocked
 */
const delayQcRework: CauseRule = {
  code: 'DELAY_QC_REWORK',
  domain: 'quality',
  type: 'QUALITY_ISSUE',
  title: '质量问题导致返工',
  evaluate: (ctx): CauseEvaluation | null => {
    const reports = (ctx.productionReports || []) as any[];

    // 检查不良率：有任何一份报告 defect_rate > 5%
    const highDefectReports = reports.filter(r => {
      const dr = Number(r.defect_rate ?? 0);
      return dr > 5;
    });

    // 检查尾查 blocked
    const finalQc = ctx.milestones.find((m: any) => m.step_key === 'final_qc_check');
    const finalQcBlocked = finalQc && (
      String(finalQc.status || '').toLowerCase() === 'blocked'
      || String(finalQc.status || '') === '卡住'
    );

    if (highDefectReports.length === 0 && !finalQcBlocked) return null;

    const worstDefectRate = highDefectReports.length > 0
      ? Math.max(...highDefectReports.map(r => Number(r.defect_rate ?? 0)))
      : 0;

    const severity: 'high' | 'critical' =
      finalQcBlocked || worstDefectRate >= 15 ? 'critical' : 'high';

    const reasons: string[] = [];
    if (highDefectReports.length > 0) reasons.push(`不良率最高达 ${worstDefectRate.toFixed(1)}%`);
    if (finalQcBlocked) reasons.push('尾查节点已阻塞');

    return {
      matched: true,
      stage: 'C',
      severity,
      impact_days: finalQcBlocked ? 7 : 3, // 估算返工天数
      impact_cost: 0,
      responsible_role: 'qc',
      evidence: {
        high_defect_reports: highDefectReports.slice(0, 5).map(r => ({
          report_date: r.report_date,
          defect_rate: r.defect_rate,
          qty_defect: r.qty_defect,
          qty_produced: r.qty_produced,
        })),
        worst_defect_rate: worstDefectRate,
        final_qc_status: finalQc?.status,
        final_qc_blocked: finalQcBlocked,
      },
      confidence: 0.9,
      description: `${reasons.join('；')}。建议品控立即介入返工方案，跟单同步与客户沟通可能的交期影响。`,
    };
  },
};

export const qualityCauseRules: CauseRule[] = [delayQcRework];
