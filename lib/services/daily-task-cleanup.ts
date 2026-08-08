/**
 * 节点完成 → 清理 my-today 僵尸待办(R1-E 统一,2026-08-09)。
 *
 * 三条完成路径(手动 markMilestoneDone / 批次自动推进 / Agent 执行)此前只有第一条
 * 会清理,且曾用 session 客户端被 RLS 滤 0 行(僵尸卡 300+ 张)。统一到本 helper:
 * service-role(完成人≠被派人是常态)+ 查 error;0 行合法(节点未必生成过待办)。
 */
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function cleanMilestoneDailyTasks(milestoneId: string): Promise<void> {
  try {
    const svc = createServiceRoleClient();
    const { error } = await (svc.from('daily_tasks') as any)
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('related_milestone_id', milestoneId)
      .in('task_type', ['milestone_overdue', 'milestone_due_today'])
      .eq('status', 'pending')
      .select('id');
    if (error) console.error('[daily-task-cleanup] 失败:', error.message);
  } catch (e: any) { console.error('[daily-task-cleanup] 异常:', e?.message); }
}
