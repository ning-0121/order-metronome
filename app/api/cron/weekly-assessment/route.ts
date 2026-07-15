import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { buildExecutionSummary } from '@/app/actions/execution-analytics';

/**
 * 每周一自动出上周执行力周报(方案 B)。
 *  - 给每个有产出的人发个人周报(分数/排名/等级/达标或红线);
 *  - 给 admin/各经理发团队周报(红榜 Top3 + 红线名单 + 达标人数)。
 * 站内通知即达;考核基线在算法里已生效(基线前不追溯)。
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'missing supabase env' }, { status: 500 });
  const svc = createClient(url, key);

  try {
    const summary = await buildExecutionSummary(svc, 'week');
    const ranked = summary.rankings.filter((r) => r.completedCount > 0);
    if (ranked.length === 0) return NextResponse.json({ ok: true, note: '上周无产出,不发周报' });

    // 1) 个人周报
    const rows = ranked.map((r, idx) => ({
      user_id: r.userId,
      type: 'weekly_assessment',
      title: `📊 上周执行力 ${r.executionScore}分·${r.grade}级${r.redLine ? '·🔴红线' : r.qualified ? '·✅达标' : ''}`,
      message: `排名 ${idx + 1}/${ranked.length}｜完成 ${r.completedCount} · 逾期率 ${r.overdueRate}% · 当前逾期 ${r.currentOverdueCount}${r.redLine ? `｜红线:${r.redLineReasons.join('、')}` : ''}。及时录入、按时完成本职节点即可拿达标/红榜/全勤奖。`,
      related_order_id: null,
      related_milestone_id: null,
      status: 'unread',
      email_sent: false,
    }));
    await (svc.from('notifications') as any).insert(rows);

    // 2) 团队周报(admin + 各经理)
    const top3 = ranked.slice(0, 3).map((r, i) => `${['🥇', '🥈', '🥉'][i]}${r.name}(${r.executionScore})`).join(' ');
    const redList = summary.rankings.filter((r) => r.redLine).map((r) => r.name).join('、') || '无';
    const qualifiedN = summary.rankings.filter((r) => r.qualified).length;
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(svc as any, ['admin', 'order_manager', 'sales_manager', 'procurement_manager', 'production_manager'], {
      type: 'weekly_assessment_team',
      title: `📊 上周执行力周报·团队均分 ${summary.teamAvg.executionScore}`,
      message: `红榜 ${top3}｜🔴红线:${redList}｜达标 ${qualifiedN} 人。详见「执行力看板」。`,
    });

    return NextResponse.json({ ok: true, personal: rows.length, teamAvg: summary.teamAvg.executionScore });
  } catch (e: any) {
    console.error('[weekly-assessment] 失败:', e?.message);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
