/**
 * 每日业务简报 Cron — R1-B 重写(2026-08-08)
 *
 * 【旧版为什么停摆】收件人圈 role='sales',但只读数据分析实证(2026-08-08):
 * 90 张 active 订单的 owner 全部是 merchandiser(87 张)+ 王海莲(3 张),
 * role='sales' 的 4 个账号 owner=0、created=0(闲置账号)——7-13 前后皆如此,
 * 不是移交造成的,是圈定口径从一开始就错了。于是逐人 return null,
 * generated=0,HTTP 200,自 7-13 起无人收到简报也无人察觉。
 *
 * 【新口径(证据充分,与 CEO 2026-08 名册一致:merchandiser=业务执行人)】
 * 收件人 = 当前 active 订单的真实 owner_user_id(去重),不看角色 ——
 * 简报内容本就是 owner 视角(我的订单/我的客户邮件/我的到期节点),
 * 谁真的在管单,谁收简报;将来归属再变也自动跟上。
 *
 * 健康规则:eligible(有 active 单的 owner 数)>0 而 generated=0 → FAILED;
 * eligible=0 → 明确 no_work,不是模糊 success。幂等:daily_briefings 有
 * UNIQUE(user_id, briefing_date) upsert;通知按当日去重。
 */

import { generateBriefingForUser } from '@/lib/agent/dailyBriefing';
import { runAutomationJob, type JobOutcome } from '@/lib/automation/run-job';
import { AGENT_FLAGS } from '@/lib/agent/featureFlags';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

const ACTIVE_STATUSES = ['执行中', 'running', 'active', '已生效'];

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const r = await runAutomationJob('daily-briefing', { trigger: 'cron' }, async (svc): Promise<JobOutcome> => {
    if (!AGENT_FLAGS.dailyBriefing()) {
      return { eligible: 0, processed: 0, metadata: { skipped_reason: 'AGENT_FLAG_DAILY_BRIEFING=false' } };
    }
    const todayStr = new Date().toISOString().slice(0, 10);

    // 收件人 = active 订单的去重 owner(证据口径,见文件头)
    const { data: activeOrders, error: ordersErr } = await (svc.from('orders') as any)
      .select('owner_user_id').in('lifecycle_status', ACTIVE_STATUSES).not('owner_user_id', 'is', null);
    if (ordersErr) return { errorCode: 'ORDERS_READ_FAILED', errorMessage: ordersErr.message };
    const ownerIds = [...new Set((activeOrders || []).map((o: any) => o.owner_user_id))] as string[];
    if (ownerIds.length === 0) {
      return { eligible: 0, processed: 0, metadata: { note: '无 active 订单 owner(no_work)' } };
    }

    const { data: owners, error: profErr } = await (svc.from('profiles') as any)
      .select('user_id, name, email, wechat_push_key').in('user_id', ownerIds);
    if (profErr) return { errorCode: 'PROFILES_READ_FAILED', errorMessage: profErr.message };

    let generated = 0, pushed = 0, failed = 0, notifCreated = 0;
    const perUser: Array<{ name: string; ok: boolean; reason?: string }> = [];

    // 并行生成(2026-08-08 生产实测:7 人串行 AI 调用超 60s 函数上限 → 整批被杀。
    // 各人完全独立,upsert/去重保证幂等,并行安全;整批耗时 = 最慢一人 ≈ 25s)
    await Promise.all(((owners || []) as any[]).map(async (user) => {
      try {
        const result = await generateBriefingForUser(svc, user.user_id, user.name || user.email || '');
        if (!result) { failed++; perUser.push({ name: user.name, ok: false, reason: 'generator 返回空(该 owner 有单,不该为空)' }); return; }

        // 幂等落库:UNIQUE(user_id, briefing_date)
        const { error: insertError } = await (svc.from('daily_briefings') as any).upsert({
          user_id: user.user_id, briefing_date: todayStr,
          content: result.content, summary_text: result.summaryText,
          total_emails: result.totalEmails, urgent_count: result.urgentCount, compliance_count: result.complianceCount,
        }, { onConflict: 'user_id,briefing_date' });
        if (insertError) { failed++; perUser.push({ name: user.name, ok: false, reason: insertError.message }); return; }
        generated++;

        // 站内通知(当日去重,重试不刷屏)
        const { data: dup } = await (svc.from('notifications') as any)
          .select('id').eq('user_id', user.user_id).eq('type', 'daily_briefing')
          .gte('created_at', todayStr + 'T00:00:00').limit(1);
        if (!(dup || []).length) {
          const { insertNotifications } = await import('@/lib/utils/notifications');
          const nres = await insertNotifications({
            user_id: user.user_id, type: 'daily_briefing',
            title: `📋 今日简报 — ${result.totalEmails}封邮件 ${result.urgentCount > 0 ? `🚨${result.urgentCount}个紧急` : ''}`,
            message: result.summaryText.slice(0, 300),
          });
          if (nres.ok) notifCreated++;
        }

        if (user.wechat_push_key) {
          try {
            const { sendWechatPush } = await import('@/lib/utils/wechat-push');
            await sendWechatPush(user.wechat_push_key, `📋 今日简报 ${todayStr}`, result.summaryText);
            await (svc.from('daily_briefings') as any).update({ wechat_sent: true })
              .eq('user_id', user.user_id).eq('briefing_date', todayStr);
            pushed++;
          } catch { /* 推送失败不算简报失败 */ }
        }
        perUser.push({ name: user.name, ok: true });
      } catch (e: any) {
        failed++; perUser.push({ name: user.name, ok: false, reason: e?.message });
      }
    }));

    return {
      eligible: ownerIds.length, processed: generated,
      failedItems: failed, notificationsCreated: notifCreated,
      metadata: { date: todayStr, pushed, per_user: perUser },
    };
  });

  return NextResponse.json({
    ok: r.status !== 'failed', status: r.status, health: r.health,
    run_id: r.runId, reasons: r.reasons,
    generated: r.outcome.processed ?? 0, eligible: r.outcome.eligible ?? 0,
  }, { status: r.httpStatus });
}

export async function GET(req: Request) { return POST(req); }
