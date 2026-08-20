/**
 * 部门执行考核(2026-07-25 CEO:采购/生产/QC 中心的活也要考核)。纯逻辑,便于单测。
 * 关键中心动作 → 一条 department_assessments 记录(目标日 vs 实际日 → on_time)→ 评分引擎读它给部门分卡。
 */

// 部门收成 2 个:采购部 + 生产部(含 QC/跟单,对应名册"生产部有跟单和QC")。
export type Department = 'procurement' | 'production';
export const DEPARTMENTS: Department[] = ['procurement', 'production'];

/**
 * 节点完成 → 落哪个部门的哪条考核(单一真相)。
 *
 * 2026-08-20 收口:此前这份映射在 app/actions/milestones.ts 里内联一份、
 * scripts/backfill-dept-assessments.mts 里又抄一份 —— 加考核节点时极易只改一处,
 * 于是新数据有、回填没有(或反过来)。放到这里,两边都 import。
 *
 * ⚠️ 只放**节点完成**驱动的任务。采购下单(bulk_po_placed)由 placeCore 触发、
 *    不走节点,故不在此表。
 */
export const DEPT_TASK_BY_STEP: Record<string, { dept: Department; key: string; label: string }> = {
  final_qc_check: { dept: 'production', key: 'qc_passed', label: '尾查合格' },
  mid_qc_check: { dept: 'production', key: 'mid_qc_passed', label: '中查完成' },
  factory_completion: { dept: 'production', key: 'production_done', label: '生产完成' },
  materials_received_inspected: { dept: 'procurement', key: 'materials_received', label: '原辅料到货验收' },
};

/** 部门 → 系统角色(评分/负责人归属)。 */
export const DEPT_ROLES: Record<Department, string[]> = {
  procurement: ['procurement', 'procurement_manager'],
  production: ['production', 'production_manager', 'qc', 'quality'],
};

/** 准时判定:实际日 ≤ 目标日 = 准时;缺目标日 → null(不计入准时率)。纯函数。 */
export function isOnTime(targetDate: string | null | undefined, actualDate: string | null | undefined): boolean | null {
  if (!targetDate) return null;
  const t = new Date(String(targetDate).slice(0, 10) + 'T23:59:59+08:00').getTime();  // 目标日当天算准时
  const a = new Date(String(actualDate || new Date().toISOString()).slice(0, 10) + 'T00:00:00+08:00').getTime();
  if (isNaN(t) || isNaN(a)) return null;
  return a <= t;
}

/** 一个部门在某单的考核 → 分数(准时率×100;无可判定任务 → 满分 100,不冤枉)。 */
export function computeDeptScore(assessments: Array<{ on_time?: boolean | null }>): {
  total: number; assessed: number; onTime: number; late: number; score: number;
} {
  const assessed = (assessments || []).filter((a) => a.on_time === true || a.on_time === false);
  const onTime = assessed.filter((a) => a.on_time === true).length;
  const late = assessed.length - onTime;
  const score = assessed.length === 0 ? 100 : Math.round((onTime / assessed.length) * 100);
  return { total: (assessments || []).length, assessed: assessed.length, onTime, late, score };
}
