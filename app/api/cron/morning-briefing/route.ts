/**
 * 每日邮件晨报 cron — 北京时间凌晨 00:00 执行
 *
 * Vercel cron 用 UTC，北京时间 00:00 = UTC 16:00（前一天）
 * 在 vercel.json 配置："schedule": "0 16 * * *"
 *
 * 流程：
 *   1. 收集"昨日"（北京时间昨天 00:00 ~ 今日 00:00）所有邮件相关数据
 *   2. 调用 Claude 生成业务员视角的晨报摘要
 *   3. 写入 daily_briefings 表（briefing_date = 今天，content jsonb 含 morning_email 字段）
 *   4. 给每个 sales 用户发 notification（type='morning_briefing'）
 *
 * 设计原则（20 年外贸业务视角）：
 *   - 不堆数据，只给"今天必须做的事"
 *   - 紧急/差异/慢确认 三栏置顶
 *   - 数据来源透明（邮件 ID + 客户名）
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { callClaudeJSON } from '@/lib/agent/anthropicClient';

export const maxDuration = 60;

/** 北京时间昨天 00:00 ~ 今天 00:00 的 UTC 时间窗 */
function getBjYesterdayWindow(): { start: string; end: string; bjDate: string } {
  // 当前 UTC 时间
  const nowUtc = new Date();
  // 北京时间今天 00:00 的 UTC 表示 = 北京 = UTC+8，所以 北京 0 点 = UTC 16:00 前一天
  // 简单做法：取北京当前时间，去掉时分秒
  const bjOffset = 8 * 60 * 60 * 1000;
  const bjNow = new Date(nowUtc.getTime() + bjOffset);
  const bjToday = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()));
  const bjYesterday = new Date(bjToday.getTime() - 24 * 60 * 60 * 1000);
  // 转回 UTC 用于查询
  return {
    start: new Date(bjYesterday.getTime() - bjOffset).toISOString(),
    end: new Date(bjToday.getTime() - bjOffset).toISOString(),
    bjDate: bjToday.toISOString().slice(0, 10),
  };
}

export async function POST(req: Request) {
  return handleBriefing(req);
}

export async function GET(req: Request) {
  return handleBriefing(req);
}

async function handleBriefing(req: Request) {
  // 安全：要求 CRON_SECRET
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Missing config' }, { status: 500 });
    }
    const supabase = createClient(url, serviceKey);

    const { start, end, bjDate } = getBjYesterdayWindow();

    // ── 1. 拉所有 sales 用户 ──
    const { data: salesProfiles } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role, roles')
      .or('role.eq.sales,roles.cs.{sales}');

    if (!salesProfiles || salesProfiles.length === 0) {
      return NextResponse.json({ message: 'no sales users', date: bjDate });
    }

    let generated = 0;
    const errors: string[] = [];

    for (const profile of salesProfiles) {
      try {
        const briefing = await generateMorningBriefingForSales(supabase, profile.user_id, profile.name || profile.email, start, end);

        // 写入 daily_briefings（按 user_id + briefing_date 唯一）
        await (supabase.from('daily_briefings') as any).upsert(
          {
            user_id: profile.user_id,
            briefing_date: bjDate,
            content: { morning_email: briefing },
            summary_text: briefing.headline || '今日邮件晨报',
            total_emails: briefing.totalEmailsYesterday || 0,
            urgent_count: briefing.urgentItems?.length || 0,
            compliance_count: briefing.openDiffs?.length || 0,
          },
          { onConflict: 'user_id,briefing_date' },
        );

        // 站内通知
        await (supabase.from('notifications') as any).insert({
          user_id: profile.user_id,
          type: 'morning_briefing',
          title: `📧 今日邮件晨报 — ${bjDate}`,
          message: briefing.headline || '点击查看今日要处理的邮件清单',
        });

        generated++;
      } catch (err: any) {
        errors.push(`${profile.name}: ${err?.message}`);
        console.error(`[morning-briefing] ${profile.name}:`, err?.message);
      }
    }

    return NextResponse.json({
      success: true,
      date: bjDate,
      generated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error('[morning-briefing] outer error:', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

/**
 * 给单个业务员生成今日邮件晨报
 *
 * 内容（按 20 年外贸业务最关心的优先级）：
 *  1. 🔥 紧急（urgent_level / 投诉 / 拒收）
 *  2. ⚠️ 邮件-订单差异（open）
 *  3. 🐢 客户慢确认提醒（等了 5+ 天没回的关键节点）
 *  4. 📧 昨日新邮件（按客户分组）
 *  5. 📋 今日 Top 5 必须回的邮件
 *  6. 💀 被吞掉的邮件（无声失败）
 */
async function generateMorningBriefingForSales(
  supabase: any,
  userId: string,
  userName: string,
  windowStart: string,
  windowEnd: string,
): Promise<any> {
  // 该业务员负责的客户
  const { data: myOrders } = await (supabase.from('orders') as any)
    .select('id, customer_name, order_no')
    .eq('owner_user_id', userId)
    .in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);
  const myCustomers = [...new Set((myOrders || []).map((o: any) => o.customer_name).filter(Boolean))];
  const myOrderIds = (myOrders || []).map((o: any) => o.id);

  if (myCustomers.length === 0) {
    return { headline: '今日无活跃订单', totalEmailsYesterday: 0 };
  }

  // ── 1. 昨日新邮件 ──
  const { data: newEmails } = await (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, raw_body, received_at, customer_id, order_id, processing_status')
    .in('customer_id', myCustomers)
    .gte('received_at', windowStart)
    .lt('received_at', windowEnd)
    .not('from_email', 'ilike', '%@qimoclothing.com')
    .order('received_at', { ascending: false })
    .limit(50);

  // ── 2. 紧急邮件（紧急通知 / 投诉关键词）──
  const urgentEmails = (newEmails || []).filter((e: any) => {
    const text = `${e.subject || ''} ${e.raw_body || ''}`.toLowerCase();
    return /urgent|asap|complaint|reject|不良|投诉|紧急|催|延期|wrong|defect|cancel/i.test(text);
  });

  // ── 3. 邮件-订单差异（open）──
  const { data: openDiffs } = await (supabase.from('email_order_diffs') as any)
    .select('id, order_id, field, email_value, order_value, severity, suggestion, detected_at')
    .in('order_id', myOrderIds.length > 0 ? myOrderIds : ['00000000-0000-0000-0000-000000000000'])
    .eq('status', 'open')
    .order('severity', { ascending: false })
    .limit(20);

  // ── 4. 慢确认提醒：当前在 in_progress 状态、依赖客户回复、超过 5 天 ──
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const slowConfirmSteps = [
    'pre_production_sample_approved',
    'finance_approval',
    'po_confirmed',
    'packing_method_confirmed',
  ];
  const { data: slowMilestones } = await (supabase.from('milestones') as any)
    .select('id, order_id, name, step_key, status, due_at')
    .in('order_id', myOrderIds.length > 0 ? myOrderIds : ['00000000-0000-0000-0000-000000000000'])
    .in('step_key', slowConfirmSteps)
    .in('status', ['in_progress', '进行中'])
    .lt('due_at', fiveDaysAgo)
    .limit(20);

  // ── 5. 被吞掉的邮件（昨日 unmatched / matched_customer）──
  const { data: silentFailMails } = await (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, received_at, processing_status')
    .gte('received_at', windowStart)
    .lt('received_at', windowEnd)
    .in('processing_status', ['unmatched', 'matched_customer'])
    .order('received_at', { ascending: false })
    .limit(10);

  // 按客户分组邮件，便于业务一眼看懂
  const emailsByCustomer = new Map<string, any[]>();
  for (const e of newEmails || []) {
    const key = e.customer_id || '未识别客户';
    const list = emailsByCustomer.get(key) || [];
    list.push(e);
    emailsByCustomer.set(key, list);
  }

  // ── 6. 调用 Claude 生成"今日 Top 5 必须回的邮件"+ 一句话总结 ──
  let aiAdvice: any = null;
  if ((newEmails || []).length > 0 || (urgentEmails || []).length > 0 || (openDiffs || []).length > 0) {
    const emailContext = Array.from(emailsByCustomer.entries())
      .slice(0, 15)
      .map(([cust, emails]) => `【${cust}】${emails.length}封\n${emails.slice(0, 3).map((e: any) => `  - ${e.subject?.slice(0, 80)}`).join('\n')}`)
      .join('\n');

    const urgentContext = urgentEmails.slice(0, 5).map((e: any) =>
      `- [${e.customer_id || '?'}] ${e.subject?.slice(0, 100)}`
    ).join('\n');

    const diffContext = (openDiffs || []).slice(0, 5).map((d: any) =>
      `- [${d.severity}] ${d.field}：邮件「${(d.email_value || '').slice(0, 50)}」 vs 订单「${(d.order_value || '').slice(0, 50)}」`
    ).join('\n');

    const slowContext = (slowMilestones || []).slice(0, 5).map((m: any) => {
      const order = (myOrders || []).find((o: any) => o.id === m.order_id);
      return `- ${order?.order_no || '?'} ${order?.customer_name || '?'} / ${m.name} (截止${m.due_at?.slice(0, 10)})`;
    }).join('\n');

    const prompt = `你是一个有 20 年经验的外贸服装业务总监。
现在是${userName}的早晨 8 点，请帮她梳理今天最重要的邮件工作。

## 昨日新邮件（${(newEmails || []).length}封）
${emailContext || '无'}

## 紧急/投诉关键词命中
${urgentContext || '无'}

## 邮件 vs 订单差异（待处理）
${diffContext || '无'}

## 客户慢确认（已等 5 天+）
${slowContext || '无'}

请给出 JSON 格式的早晨建议：
{
  "headline": "一句话总结今天最关键的事（不超过 30 字）",
  "topActions": [
    { "rank": 1, "action": "今天上午必须做的事（具体、可执行）", "reason": "为什么", "customer": "客户名（可选）", "orderNo": "订单号（可选）" }
  ]
}

只返回 JSON。topActions 至多 5 条，按紧急度排序。
不要空话套话，每条都必须可立即执行。`;

    aiAdvice = await callClaudeJSON({
      scene: 'morning_briefing',
      prompt,
      maxTokens: 1500,
      timeoutMs: 25_000,
    });
  }

  // 组装最终结构
  return {
    bjDate: windowEnd.slice(0, 10),
    headline: aiAdvice?.headline || `昨日 ${(newEmails || []).length} 封新邮件，请处理`,
    topActions: aiAdvice?.topActions || [],

    totalEmailsYesterday: (newEmails || []).length,
    urgentEmailsCount: urgentEmails.length,
    openDiffsCount: (openDiffs || []).length,
    slowConfirmCount: (slowMilestones || []).length,
    silentFailCount: (silentFailMails || []).length,

    // 详情列表（UI 展示用）
    urgentItems: urgentEmails.slice(0, 10).map((e: any) => ({
      id: e.id,
      customer: e.customer_id,
      subject: e.subject,
      receivedAt: e.received_at,
    })),
    openDiffs: (openDiffs || []).slice(0, 15).map((d: any) => {
      const order = (myOrders || []).find((o: any) => o.id === d.order_id);
      return {
        id: d.id,
        orderId: d.order_id,
        orderNo: order?.order_no,
        customer: order?.customer_name,
        field: d.field,
        emailValue: d.email_value,
        orderValue: d.order_value,
        severity: d.severity,
        suggestion: d.suggestion,
      };
    }),
    slowConfirms: (slowMilestones || []).map((m: any) => {
      const order = (myOrders || []).find((o: any) => o.id === m.order_id);
      return {
        orderId: m.order_id,
        orderNo: order?.order_no,
        customer: order?.customer_name,
        milestone: m.name,
        dueAt: m.due_at,
        daysOverdue: Math.floor((Date.now() - new Date(m.due_at).getTime()) / 86400000),
      };
    }),
    emailsByCustomer: Array.from(emailsByCustomer.entries()).map(([cust, emails]) => ({
      customer: cust,
      count: emails.length,
      latestSubject: emails[0]?.subject || '',
    })),
    silentFailMails: (silentFailMails || []).map((m: any) => ({
      id: m.id,
      from: m.from_email,
      subject: m.subject,
      status: m.processing_status,
    })),
  };
}
