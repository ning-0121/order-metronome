'use server';

/**
 * 部门执行考核记录(2026-07-25 CEO:采购/生产/QC 中心的活也要考核)。
 * 关键中心动作调 recordDeptAssessment 落一条(幂等 upsert),评分引擎 calculateOrderScore 读它给部门分卡。
 * fire-and-forget:失败/缺表都不阻断主链路(考核是旁路,别拖垮下单/收货/报告)。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { isOnTime, type Department } from '@/lib/domain/deptAssessment';

/** 落一条部门考核记录。target_date 缺则 on_time=null(不计入准时率);actual_date 缺则取今天。 */
export async function recordDeptAssessment(orderId: string, dept: Department, input: {
  task_key: string; task_label?: string; user_id?: string | null;
  target_date?: string | null; actual_date?: string | null; note?: string;
}): Promise<void> {
  try {
    if (!orderId || !input.task_key) return;
    const actual = input.actual_date || new Date().toISOString().slice(0, 10);
    const onTime = isOnTime(input.target_date, actual);
    const svc = createServiceRoleClient();
    await (svc.from('department_assessments') as any).upsert({
      order_id: orderId, department: dept, task_key: input.task_key,
      task_label: input.task_label || null, user_id: input.user_id || null,
      target_date: input.target_date || null, actual_date: actual, on_time: onTime,
      note: input.note || null, updated_at: new Date().toISOString(),
    }, { onConflict: 'order_id,department,task_key' });
  } catch { /* 考核旁路,缺表/失败都不阻断主链路 */ }
}

/** 取某里程碑 step_key 的 due_at(给考核当目标日)。取不到返回 null。 */
export async function milestoneDueDate(svc: any, orderId: string, stepKeys: string[]): Promise<string | null> {
  try {
    const { data } = await (svc.from('milestones') as any)
      .select('due_at, step_key').eq('order_id', orderId).in('step_key', stepKeys).limit(1).maybeSingle();
    return (data as any)?.due_at ? String((data as any).due_at).slice(0, 10) : null;
  } catch { return null; }
}
