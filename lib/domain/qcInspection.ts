/**
 * QC 检验(qc_inspections)的领域常量 —— 纯模块。
 *
 * ⚠️ 必须放在这里,不能放 app/actions/qc.ts:那是 'use server' 文件,
 * 只允许导出 async function。导出常量/对象能过 build,但运行时报
 * `A "use server" file can only export async functions, found object`,
 * 会把整条 action chunk 打挂(见 [[use-server-export-guard]] 那次事故)。
 */

/** 检验类型 → 中文名。UI、通知、导出共用一份,避免各写各的。 */
export const QC_TYPE_LABELS: Record<string, string> = {
  line_start: '上线审查',
  mid: '中期验货',
  final: '尾期验货',
  inline: '巡查',
  're-inspection': '复检',
  extra: '加查',
};

/** 主管可以委派的类型(中查/尾查走里程碑节点,不在这里派) */
export const QC_ASSIGNABLE_TYPES = ['extra', 'line_start', 're-inspection', 'inline'] as const;

/** 任务状态 → 中文名 + 样式 */
export const QC_TASK_STATUS: Record<string, { label: string; cls: string }> = {
  assigned:    { label: '待检验', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  in_progress: { label: '检验中', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  done:        { label: '已出结论', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  cancelled:   { label: '已取消', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
};

/** 检验结论 → 中文名 + 样式 */
export const QC_RESULT_LABELS: Record<string, { label: string; cls: string }> = {
  pending:     { label: '待判定', cls: 'text-gray-500' },
  pass:        { label: '合格', cls: 'text-emerald-700' },
  fail:        { label: '不合格', cls: 'text-rose-700' },
  conditional: { label: '有条件放行', cls: 'text-amber-700' },
};

export function qcTypeLabel(t: string | null | undefined): string {
  return QC_TYPE_LABELS[String(t || '')] || String(t || '未知');
}
