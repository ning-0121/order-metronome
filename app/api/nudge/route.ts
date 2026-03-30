import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmailNotification } from '@/lib/utils/notifications';
import { getCurrentUserRole, isAdmin } from '@/lib/utils/user-role';

/**
 * POST /api/nudge
 * Send nudge email to milestone owner
 * Rate limit: 1 nudge per milestone per hour
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user || !user.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 所有登录用户都可以催办（催其他角色逾期的关卡）
    const body = await request.json();
    const milestone_id = body.milestone_id || body.milestoneId;
    const customMessage = body.message || '';

    if (!milestone_id) {
      return NextResponse.json({ error: 'milestone_id is required' }, { status: 400 });
    }

    // Get milestone
    const { data: milestone, error: milestoneError } = await supabase
      .from('milestones')
      .select('*, orders!inner(id, order_no, customer_name, created_by)')
      .eq('id', milestone_id)
      .single();

    if (milestoneError || !milestone) {
      return NextResponse.json({ error: 'Milestone not found' }, { status: 404 });
    }

    const milestoneData = milestone as any;
    const orderData = milestoneData.orders;

    // Rate limit check: Check if nudge was sent in last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentNudges } = await supabase
      .from('milestone_logs')
      .select('id')
      .eq('milestone_id', milestone_id)
      .eq('action', 'nudge')
      .gte('created_at', oneHourAgo)
      .limit(1);

    if (recentNudges && recentNudges.length > 0) {
      return NextResponse.json(
        { error: '已在1小时内发送过催办，请稍后再试' },
        { status: 429 }
      );
    }

    // Get milestone owner email (fallback to order creator)
    let recipientEmail = '';
    let recipientName = '';

    if (milestoneData.owner_user_id) {
      const { data: ownerProfile } = await supabase
        .from('profiles')
        .select('email, name')
        .eq('user_id', milestoneData.owner_user_id)
        .single();
      if (ownerProfile) {
        recipientEmail = (ownerProfile as any).email || '';
        recipientName = (ownerProfile as any).name ?? (ownerProfile as any).email ?? '';
      }
    }

    if (!recipientEmail && orderData.created_by) {
      const { data: creatorProfile } = await supabase
        .from('profiles')
        .select('email, name')
        .eq('user_id', orderData.created_by)
        .single();
      if (creatorProfile) {
        recipientEmail = (creatorProfile as any).email || '';
        recipientName = (creatorProfile as any).name ?? (creatorProfile as any).email ?? '';
      }
    }

    // Final fallback to current user email
    if (!recipientEmail) {
      recipientEmail = user.email;
    }

    // Log nudge action
    await (supabase.from('milestone_logs') as any).insert({
      milestone_id: milestone_id,
      order_id: orderData.id,
      actor_user_id: user.id,
      action: 'nudge',
      note: `Nudge sent to ${recipientEmail}`,
      payload: { recipient_email: recipientEmail },
    });

    // 获取催办人名称
    const { data: senderProfile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
    const senderName = (senderProfile as any)?.name || user.email?.split('@')[0] || '同事';

    // 写入应用内通知（铃铛 + 浏览器弹窗）给被催的人
    const notifMsg = customMessage
      ? `${senderName}：「${customMessage}」\n订单 ${orderData.order_no}（${orderData.customer_name}）· ${milestoneData.name}`
      : `订单 ${orderData.order_no}（${orderData.customer_name}）的「${milestoneData.name}」已逾期，请尽快处理`;

    if (milestoneData.owner_user_id) {
      await (supabase.from('notifications') as any).insert({
        user_id: milestoneData.owner_user_id,
        type: 'nudge',
        title: `${senderName} 催你处理「${milestoneData.name}」`,
        message: notifMsg,
        related_order_id: orderData.id,
        related_milestone_id: milestone_id,
        status: 'unread',
      });
    }

    // Send email
    const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];
    const messageHtml = customMessage
      ? `<div style="margin:12px 0;padding:12px 16px;background:#fef3c7;border-left:4px solid #d97706;border-radius:4px;"><p style="margin:0;font-size:14px;color:#92400e;"><strong>${senderName} 留言：</strong>${customMessage}</p></div>`
      : '';

    const subject = `[催办] ${orderData.order_no} — ${milestoneData.name} 需要尽快处理`;
    const html = `
      <h2 style="color:#d97706;">有同事在催你啦</h2>
      <p><strong>${senderName}</strong> 提醒你尽快处理以下节点：</p>
      ${messageHtml}
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px;font-weight:bold;">订单号</td><td style="padding:4px 12px;">${orderData.order_no}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">客户</td><td style="padding:4px 12px;">${orderData.customer_name}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">待处理节点</td><td style="padding:4px 12px;font-weight:bold;color:#dc2626;">${milestoneData.name}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">截止日期</td><td style="padding:4px 12px;">${milestoneData.due_at ? new Date(milestoneData.due_at).toLocaleDateString('zh-CN') : '未设定'}</td></tr>
      </table>
      <p>请尽快登录系统处理，避免影响后续环节。</p>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com'}/orders/${orderData.id}?tab=progress" style="display:inline-block;padding:8px 20px;background:#4f46e5;color:white;border-radius:8px;text-decoration:none;font-weight:bold;">去处理</a></p>
    `;

    const emailSent = await sendEmailNotification([recipientEmail, ...ccEmails], subject, html);

    if (!emailSent) {
      return NextResponse.json(
        { error: '邮件发送失败，请检查 SMTP 配置或稍后重试' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Nudge sent successfully',
      recipient_email: recipientEmail,
    });
  } catch (error: any) {
    console.error('Error sending nudge:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
