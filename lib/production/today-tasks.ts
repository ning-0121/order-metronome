import type { SupabaseClient } from '@supabase/supabase-js';
import { getDailyTasks, generateDailyTasks } from '@/lib/services/daily-tasks.service';

/** 生产今日工作台的 7 类任务(见 daily-tasks.service generateProductionTasks/IssueTasks)。 */
export const PROD_TASK_TYPES = [
  'prod_material_chase', 'prod_factory_arrange', 'prod_first_day',
  'prod_mid_qc', 'prod_final_qc', 'prod_packing', 'prod_issue',
];

/**
 * 取某用户今日的生产待办;当天还没为该用户生成过(0 条任务)则触发一次幂等生成再取。
 * 生产中心首页与「我的工作台」/dashboard 共用,保证两处口径一致。
 */
export async function loadUserProductionTodayTasks(
  supabase: SupabaseClient,
  userId: string,
): Promise<any[]> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let r: any = await getDailyTasks(supabase, userId);
    let all: any[] = r?.ok ? r.data : [];
    if (all.length === 0) {
      await generateDailyTasks(supabase, { trigger: 'daily_cron', date: today });
      r = await getDailyTasks(supabase, userId);
      all = r?.ok ? r.data : [];
    }
    return all.filter((t: any) => PROD_TASK_TYPES.includes(t.task_type));
  } catch {
    return [];
  }
}
