'use server';

import { createClient } from '@/lib/supabase/server';
import { getTodayBriefing as svcGetTodayBriefing } from '@/lib/services/briefing.service';

/**
 * 获取当天简报（兼容旧调用：返回任意时间段最近一份）
 */
export async function getTodayBriefing() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await (supabase.from('daily_briefings') as any)
    .select('*')
    .eq('user_id', user.id)
    .lte('briefing_date', today)
    .order('briefing_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

// ── 2026-08-19 P2 决策单 B1:generateMyBriefingAction 随 MorningBriefingCard 删除 ──
// (CEO 判「太费钱用处不大」;/briefing 页只读缓存 getTodayBriefing,不再有任何强制调 Claude 的入口。
//  cron 侧 morning-briefing / daily-briefing 路由自行调 briefing.service,不走本文件。)
