import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmailNotification, escapeHtml } from '@/lib/utils/notifications';
import { pushToUsers } from '@/lib/utils/wechat-push';
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

    // 🔴 CEO 2026-04-09：催办点对点，不再 CC 管理员
    // 之前 CC MANAGER_CC_EMAILS 导致所有催办都刷爆 admin 收件箱、责任不明
    const messageHtml = customMessage
      ? `<div style="margin:12px 0;padding:12px 16px;background:#fef3c7;border-left:4px solid #d97706;border-radius:4px;"><p style="margin:0;font-size:14px;color:#92400e;"><strong>${escapeHtml(senderName)} 留言：</strong>${escapeHtml(customMessage)}</p></div>`
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

    // 企业微信推送
    let wecomSent = false;
    if (milestoneData.owner_user_id) {
      const wecomTitle = `${senderName} 催你处理「${milestoneData.name}」`;
      const wecomContent = notifMsg + `\n\n点击查看：${process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com'}/orders/${orderData.id}?tab=progress`;
      const sentCount = await pushToUsers(supabase, [milestoneData.owner_user_id], wecomTitle, wecomContent);
      wecomSent = sentCount > 0;
    }

    // 邮件通知 — 只发给被催的人本人（可能失败但不阻断）
    const emailSent = await sendEmailNotification(recipientEmail, subject, html);

    // ── 跨角色催办自动抄送 admin/CEO（2026-05-15）──
    // 触发条件：催办人和被催人不属于同一职能（如业务催生产）→
    //          系统自动 CC admin 角色用户，提升管理透明度。
    // 同职能催办（如生产催生产、跟单催跟单）不抄送，保持点对点。
    let ccAdminSent = false;
    let ccAdminCount = 0;
    try {
      // 查询催办人角色 + 被催人角色
      const { data: senderRoleProfile } = await supabase
        .from('profiles')
        .select('role, roles')
        .eq('user_id', user.id)
        .single();
      const senderRoles: string[] =
        (senderRoleProfile as any)?.roles?.length > 0
          ? (senderRoleProfile as any).roles
          : [(senderRoleProfile as any)?.role].filter(Boolean);

      const milestoneOwnerRole = String(milestoneData.owner_role || '').toLowerCase();
      const sameRoleGroup = (a: string, b: string) => {
        if (a === b) return true;
        // 跟单/生产/qc/quality 视为同组（都属于生产侧）
        const productionGroup = ['merchandiser', 'production', 'production_manager', 'qc', 'quality'];
        if (productionGroup.includes(a) && productionGroup.includes(b)) return true;
        // sales / sales_assistant 视为同组（业务侧）
        const salesGroup = ['sales', 'sales_assistant'];
        if (salesGroup.includes(a) && salesGroup.includes(b)) return true;
        return false;
      };
      const isCrossRole = milestoneOwnerRole && !senderRoles.some(r =>
        sameRoleGroup(String(r).toLowerCase(), milestoneOwnerRole)
      );

      if (isCrossRole) {
        // 查所有 admin 用户（role='admin' 或 roles 包含 'admin'）
        const { data: admins } = await supabase
          .from('profiles')
          .select('user_id, email, name')
          .or('role.eq.admin,roles.cs.{admin}');
        const adminList = (admins as any[] | null) || [];
        // 给 admin 写入应用内通知
        for (const a of adminList) {
          if (a.user_id === user.id) continue; // 不通知发起人自己
          await (supabase.from('notifications') as any).insert({
            user_id: a.user_id,
            type: 'cross_role_nudge',
            title: `[抄送] ${senderName} 催 ${milestoneData.name}`,
            message: `${senderName}（${senderRoles.join('/')}）正在催办「${milestoneData.name}」（${milestoneOwnerRole}负责）— 订单 ${orderData.order_no}（${orderData.customer_name}）`,
            related_order_id: orderData.id,
            related_milestone_id: milestone_id,
            status: 'unread',
          });
          // 邮件抄送（同步发送，避免阻塞主流程过久）
          if (a.email) {
            const ccSubject = `[抄送·跨部门催办] ${orderData.order_no} — ${senderName} 催 ${milestoneData.name}`;
            const ccHtml = `
              <h2 style="color:#7c3aed;">跨部门催办抄送通知</h2>
              <p><strong>${escapeHtml(senderName)}</strong>（${senderRoles.join('/')}）正在催办其他部门的节点：</p>
              <table style="border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:4px 12px;font-weight:bold;">订单号</td><td style="padding:4px 12px;">${orderData.order_no}</td></tr>
                <tr><td style="padding:4px 12px;font-weight:bold;">客户</td><td style="padding:4px 12px;">${orderData.customer_name}</td></tr>
                <tr><td style="padding:4px 12px;font-weight:bold;">节点</td><td style="padding:4px 12px;font-weight:bold;">${milestoneData.name}</td></tr>
                <tr><td style="padding:4px 12px;font-weight:bold;">节点负责角色</td><td style="padding:4px 12px;">${milestoneOwnerRole}</td></tr>
                <tr><td style="padding:4px 12px;font-weight:bold;">被催负责人</td><td style="padding:4px 12px;">${escapeHtml(recipientName || recipientEmail)}</td></tr>
              </table>
              ${messageHtml}
              <p style="color:#6b7280;font-size:12px;">此邮件为系统自动抄送 — 你不需要回复，仅作管理透明用途。</p>
              <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com'}/orders/${orderData.id}?tab=progress" style="display:inline-block;padding:8px 20px;background:#7c3aed;color:white;border-radius:8px;text-decoration:none;font-weight:bold;">查看订单</a></p>
            `;
            const sent = await sendEmailNotification(a.email, ccSubject, ccHtml);
            if (sent) ccAdminCount++;
          }
        }
        ccAdminSent = ccAdminCount > 0;
      }
    } catch (ccErr: any) {
      console.error('[Nudge] cross-role CC admin failed:', ccErr?.message);
      // CC 失败不阻塞主流程
    }

    const channels: string[] = ['系统通知'];
    if (wecomSent) channels.push('企业微信');
    if (emailSent) channels.push('邮件');
    if (ccAdminSent) channels.push(`抄送 ${ccAdminCount} 位管理员`);

    return NextResponse.json({
      success: true,
      message: `催办已发送（${channels.join('+')}）`,
      recipient_email: recipientEmail,
      emailSent,
      wecomSent,
      ccAdminSent,
      ccAdminCount,
    });
  } catch (error: any) {
    console.error('Error sending nudge:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
