/**
 * 业务员每日简报 Cron — 每日08:00北京时间
 *
 * 为每个业务员生成个性化邮件简报并推送
 */

import { createClient } from '@supabase/supabase-js';
import { generateBriefingForUser } from '@/lib/agent/dailyBriefing';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);
    const todayStr = new Date().toISOString().slice(0, 10);

    // 获取所有业务员
    const { data: salesUsers } = await supabase
      .from('profiles')
      .select('user_id, name, email, wechat_push_key, roles, role')
      .or("role.eq.sales,roles.cs.{sales}");

    if (!salesUsers || salesUsers.length === 0) {
      return NextResponse.json({ success: true, generated: 0 });
    }

    let generated = 0;
    let pushed = 0;

    for (const user of salesUsers) {
      const result = await generateBriefingForUser(
        supabase,
        user.user_id,
        user.name || user.email || '',
      );

      if (!result) continue;

      // 存入数据库
      const { error: insertError } = await supabase.from('daily_briefings').upsert({
        user_id: user.user_id,
        briefing_date: todayStr,
        content: result.content,
        summary_text: result.summaryText,
        total_emails: result.totalEmails,
        urgent_count: result.urgentCount,
        compliance_count: result.complianceCount,
      }, { onConflict: 'user_id,briefing_date' });

      if (insertError) {
        console.error(`[daily-briefing] Insert error for ${user.name}:`, insertError.message);
        continue;
      }
      generated++;

      // 系统内通知
      await supabase.from('notifications').insert({
        user_id: user.user_id,
        type: 'daily_briefing',
        title: `📋 今日简报 — ${result.totalEmails}封邮件 ${result.urgentCount > 0 ? `🚨${result.urgentCount}个紧急` : ''}`,
        message: result.summaryText.slice(0, 300),
        status: 'unread',
      });

      // 微信推送
      if (user.wechat_push_key) {
        try {
          const { sendWechatPush } = await import('@/lib/utils/wechat-push');
          const wechatTitle = `📋 今日简报 ${todayStr}`;
          const wechatContent = result.summaryText;
          await sendWechatPush(user.wechat_push_key, wechatTitle, wechatContent);
          await supabase.from('daily_briefings')
            .update({ wechat_sent: true })
            .eq('user_id', user.user_id)
            .eq('briefing_date', todayStr);
          pushed++;
        } catch {}
      }
    }

    return NextResponse.json({ success: true, generated, pushed, total: salesUsers.length });
  } catch (err: any) {
    console.error('[daily-briefing]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
