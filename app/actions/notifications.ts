'use server';

import { createClient } from '@/lib/supabase/server';
import { sendEmailNotification, MANAGER_CC_EMAILS } from '@/lib/utils/notifications';
import { isDoneStatus } from '@/lib/domain/types';
import { differenceInHours } from 'date-fns';
import { shouldSendEmail } from '@/lib/domain/notification-policy';

/**
 * Check and send reminder notifications for in_progress milestones
 * Called by cron job every 15 minutes
 */
export async function checkAndSendReminders() {
  const supabase = await createClient();
  const now = new Date();

  // Get all in_progress milestones (兼容中文状态)
  const { data: milestones, error } = await supabase
    .from('milestones')
    .select('*')
    .in('status', ['in_progress']);

  if (error || !milestones) {
    console.error('Error fetching milestones:', error);
    return { error: error?.message };
  }

  const results = [];

  for (const milestone of milestones || []) {
    const milestoneData = milestone as any;
    if (!milestoneData.due_at) continue;
    
    // Get order separately
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', milestoneData.order_id)
      .single();
    
    if (!order) continue;

    const orderData = order as any;
    const dueAt = new Date(milestoneData.due_at);
    const hoursRemaining = differenceInHours(dueAt, now);

    // Get order creator email
    let recipientEmail = '';
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('user_id', orderData.created_by)
        .single();
      recipientEmail = (profile as any)?.email || '';
    } catch (e) {
      console.error('Error getting user email:', e);
      continue;
    }
    
    if (!recipientEmail) continue;

    const ccEmails = MANAGER_CC_EMAILS;

    // Check for 48h reminder
    if (hoursRemaining <= 48 && hoursRemaining > 24) {
      const sent = await checkAndSendNotification(
        supabase,
        milestoneData.id,
        orderData.id,
        'remind_48',
        recipientEmail,
        orderData.order_no,
        milestoneData.name,
        dueAt,
        hoursRemaining,
        milestoneData.evidence_required || false,
        ccEmails
      );
      if (sent) results.push({ milestone: milestoneData.id, kind: 'remind_48' });
    }

    // Check for 24h reminder
    if (hoursRemaining <= 24 && hoursRemaining > 12) {
      const sent = await checkAndSendNotification(
        supabase,
        milestoneData.id,
        orderData.id,
        'remind_24',
        recipientEmail,
        orderData.order_no,
        milestoneData.name,
        dueAt,
        hoursRemaining,
        milestoneData.evidence_required || false,
        ccEmails
      );
      if (sent) results.push({ milestone: milestoneData.id, kind: 'remind_24' });
    }

    // Check for 12h reminder
    if (hoursRemaining <= 12 && hoursRemaining > 0) {
      const sent = await checkAndSendNotification(
        supabase,
        milestoneData.id,
        orderData.id,
        'remind_12',
        recipientEmail,
        orderData.order_no,
        milestoneData.name,
        dueAt,
        hoursRemaining,
        milestoneData.evidence_required || false,
        ccEmails
      );
      if (sent) results.push({ milestone: milestoneData.id, kind: 'remind_12' });
    }

    // Check for overdue
    if (hoursRemaining < 0) {
      const sent = await checkAndSendNotification(
        supabase,
        milestoneData.id,
        orderData.id,
        'overdue',
        recipientEmail,
        orderData.order_no,
        milestoneData.name,
        dueAt,
        hoursRemaining,
        milestoneData.evidence_required || false,
        ccEmails
      );
      if (sent) results.push({ milestone: milestoneData.id, kind: 'overdue' });

      // === 延期申请强制机制 ===
      // 检查是否已提交延期申请
      const { data: delayReqs } = await (supabase.from('delay_requests') as any)
        .select('id, status')
        .eq('milestone_id', milestoneData.id)
        .in('status', ['pending', 'approved']);

      const hasDelayRequest = delayReqs && delayReqs.length > 0;

      if (!hasDelayRequest) {
        const overdueHours = Math.abs(hoursRemaining);

        // 超期即刻：通知责任人提交延期申请
        await checkAndSendNotification(
          supabase,
          milestoneData.id,
          orderData.id,
          'delay_request_required' as any,
          recipientEmail,
          orderData.order_no,
          milestoneData.name,
          dueAt,
          hoursRemaining,
          false,
          []  // 不CC管理员，先给责任人自行处理机会
        );
        results.push({ milestone: milestoneData.id, kind: 'delay_request_required' });

        // 超期24h+未申请：升级通知管理员
        if (overdueHours >= 24) {
          for (const adminEmail of ccEmails) {
            await checkAndSendNotification(
              supabase,
              milestoneData.id,
              orderData.id,
              'delay_no_request_admin' as any,
              adminEmail,
              orderData.order_no,
              milestoneData.name,
              dueAt,
              hoursRemaining,
              false,
              []
            );
          }
          results.push({ milestone: milestoneData.id, kind: 'delay_no_request_admin' });
        }

        // 超期48h+未申请：CEO级邮件警报
        if (overdueHours >= 48) {
          for (const adminEmail of ccEmails) {
            await checkAndSendNotification(
              supabase,
              milestoneData.id,
              orderData.id,
              'delay_no_request_ceo' as any,
              adminEmail,
              orderData.order_no,
              milestoneData.name,
              dueAt,
              hoursRemaining,
              false,
              []
            );
          }
          results.push({ milestone: milestoneData.id, kind: 'delay_no_request_ceo' });
        }
      }
    }
  }

  return { data: results };
}

async function checkAndSendNotification(
  supabase: any,
  milestoneId: string,
  orderId: string,
  kind: 'remind_48' | 'remind_24' | 'remind_12' | 'overdue' | 'blocked' | 'delay_request_required' | 'delay_no_request_admin' | 'delay_no_request_ceo',
  recipientEmail: string,
  orderNo: string,
  milestoneName: string,
  dueAt: Date,
  hoursRemaining: number,
  evidenceRequired: boolean,
  ccEmails: string[]
): Promise<boolean> {
  // Check if notification already sent (prevent duplicates)
  const { data: existing } = await supabase
    .from('notifications')
    .select('id')
    .eq('milestone_id', milestoneId)
    .eq('kind', kind)
    .eq('sent_to', recipientEmail)
    .single();

  if (existing) {
    return false; // Already sent
  }

  // Create notification record
  const { error: notifError } = await supabase
    .from('notifications')
    .insert({
      milestone_id: milestoneId,
      order_id: orderId,
      kind,
      sent_to: recipientEmail,
      sent_at: new Date().toISOString(),
      payload: {
        order_no: orderNo,
        milestone_name: milestoneName,
        due_at: dueAt.toISOString(),
        hours_remaining: hoursRemaining,
        evidence_required: evidenceRequired,
      },
    });

  if (notifError) {
    console.error('Error creating notification:', notifError);
    return false;
  }

  // Send email — 根据通知类型生成不同的邮件内容
  const overdueDays = hoursRemaining < 0 ? Math.ceil(Math.abs(hoursRemaining) / 24) : 0;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com';
  let subject: string;
  let body: string;

  if (kind === 'delay_request_required') {
    subject = `[请提交延期申请] 订单 ${orderNo} — ${milestoneName} 已超期 ${overdueDays} 天`;
    body = `
      <h2 style="color:#d97706;">请提交延期申请</h2>
      <p>您负责的以下节点已超期，请尽快提交延期申请：</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px;font-weight:bold;">订单号</td><td style="padding:4px 12px;">${orderNo}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">节点</td><td style="padding:4px 12px;">${milestoneName}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">截止日期</td><td style="padding:4px 12px;">${dueAt.toLocaleDateString('zh-CN')}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;color:#dc2626;">已超期</td><td style="padding:4px 12px;color:#dc2626;font-weight:bold;">${overdueDays} 天</td></tr>
      </table>
      <p style="color:#dc2626;font-weight:bold;">⚠️ 未提交延期申请将无法标记此节点完成，且超期24小时后将自动通知管理层。</p>
      <p><a href="${appUrl}/orders" style="color:#2563eb;">点击进入系统提交延期申请 →</a></p>
    `;
  } else if (kind === 'delay_no_request_admin') {
    subject = `[管理预警] 订单 ${orderNo} — ${milestoneName} 超期 ${overdueDays} 天无人申请延期`;
    body = `
      <h2 style="color:#dc2626;">延期未申报预警</h2>
      <p>以下节点已超期超过24小时，<strong>责任人未提交延期申请</strong>，请关注：</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px;font-weight:bold;">订单号</td><td style="padding:4px 12px;">${orderNo}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">节点</td><td style="padding:4px 12px;">${milestoneName}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">截止日期</td><td style="padding:4px 12px;">${dueAt.toLocaleDateString('zh-CN')}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;color:#dc2626;">已超期</td><td style="padding:4px 12px;color:#dc2626;font-weight:bold;">${overdueDays} 天</td></tr>
      </table>
      <p>建议联系相关责任人了解原因并督促提交延期申请。</p>
      <p><a href="${appUrl}/orders" style="color:#2563eb;">进入系统查看 →</a></p>
    `;
  } else if (kind === 'delay_no_request_ceo') {
    subject = `[CEO警报] 订单 ${orderNo} — ${milestoneName} 超期 ${overdueDays} 天，无延期申请`;
    body = `
      <h2 style="color:#dc2626;">🚨 严重超期警报</h2>
      <p>以下节点已超期超过48小时，<strong>责任人未提交延期申请，可能存在管理盲区</strong>：</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px;font-weight:bold;">订单号</td><td style="padding:4px 12px;">${orderNo}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">节点</td><td style="padding:4px 12px;">${milestoneName}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">截止日期</td><td style="padding:4px 12px;">${dueAt.toLocaleDateString('zh-CN')}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;color:#dc2626;">已超期</td><td style="padding:4px 12px;color:#dc2626;font-weight:bold;">${overdueDays} 天</td></tr>
      </table>
      <p style="color:#dc2626;">此节点已被系统锁定，责任人无法在未提交延期申请的情况下标记完成。</p>
      <p><a href="${appUrl}/orders" style="color:#2563eb;">进入系统查看 →</a></p>
    `;
  } else {
    const urgency = kind === 'overdue' ? 'URGENT' : hoursRemaining <= 12 ? 'HIGH' : 'MEDIUM';
    subject = `[${urgency}] Order ${orderNo} - ${milestoneName} ${kind === 'overdue' ? 'OVERDUE' : `Due in ${hoursRemaining}h`}`;
    body = `
      <h2>Milestone Reminder</h2>
      <p><strong>Order:</strong> ${orderNo}</p>
      <p><strong>Milestone:</strong> ${milestoneName}</p>
      <p><strong>Due Date:</strong> ${dueAt.toLocaleString()}</p>
      <p><strong>Time Remaining:</strong> ${hoursRemaining < 0 ? 'OVERDUE' : `${hoursRemaining} hours`}</p>
      ${evidenceRequired ? '<p><strong>⚠️ Evidence Required</strong></p>' : ''}
      <p>Please take action to ensure this milestone is completed on time.</p>
    `;
  }

  // 通知频率策略：DIGEST 类型（remind_48/24/12/overdue）不立即发邮件，
  // 合并到每日简报；URGENT 类型（delay_no_request_*, blocked）立即发
  if (!shouldSendEmail(kind)) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[notify] ${kind} — DIGEST, 合并到每日简报`);
    }
    return true;
  }

  const allRecipients = [recipientEmail, ...ccEmails];
  await sendEmailNotification(allRecipients, subject, body);

  return true;
}

/**
 * Send blocked notification immediately when milestone is blocked
 *
 * ⚠️ 鉴权（2026-05-19 补）：之前是 'use server' 公开函数但内部假设只有
 * markMilestoneBlocked 调用 → Next.js 自动生成 RPC 端点，外部登录用户
 * 能用伪造的 milestoneId/orderId/reason 触发通知发送（钓鱼/骚扰）。
 * 现在要求：登录 + 调用者必须能访问该 milestone（owner / order owner /
 * admin），否则拒绝。
 */
export async function sendBlockedNotification(
  milestoneId: string,
  orderId: string,
  blockedReason: string
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 调用者必须对 milestone 有访问权限：admin / milestone.owner_user_id /
  // order.created_by / order.owner_user_id 任一即可
  const { data: callerProfile } = await supabase
    .from('profiles').select('roles, role').eq('user_id', user.id).single();
  const callerRoles: string[] = (callerProfile as any)?.roles?.length > 0
    ? (callerProfile as any).roles
    : [(callerProfile as any)?.role].filter(Boolean);
  const isAdmin = callerRoles.includes('admin');
  if (!isAdmin) {
    const [{ data: msAccess }, { data: orderAccess }] = await Promise.all([
      (supabase.from('milestones') as any).select('owner_user_id, order_id').eq('id', milestoneId).single(),
      (supabase.from('orders') as any).select('created_by, owner_user_id').eq('id', orderId).single(),
    ]);
    if (!msAccess || msAccess.order_id !== orderId) {
      return { error: 'milestone 与 orderId 不匹配' };
    }
    const allowed =
      msAccess.owner_user_id === user.id ||
      orderAccess?.created_by === user.id ||
      orderAccess?.owner_user_id === user.id;
    if (!allowed) {
      console.warn('[sendBlockedNotification] unauthorized call', { userId: user.id, milestoneId, orderId });
      return { error: '无权操作此节点' };
    }
  }

  // Get milestone
  const { data: milestone } = await supabase
    .from('milestones')
    .select('*')
    .eq('id', milestoneId)
    .single();

  if (!milestone) return { error: 'Milestone not found' };

  const milestoneData = milestone as any;

  // Get order separately
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (!order) return { error: 'Order not found' };

  const orderData = order as any;

  // ── 2026-05-18: 智能路由 ──
  // 根据 blockedReason 关键词决定真正需要被催的人，而不是默认只给业务发邮件。
  // 这修复了 block-and-forget bug：之前所有 blocked 都只通知业务，
  // 但「面料没到」其实要催采购，「工厂产能不够」要催生产主管。
  function inferUpstreamRole(reason: string): 'sales' | 'procurement' | 'production_manager' | 'finance' | 'qc' | 'merchandiser' | null {
    const r = reason.toLowerCase();
    // 业务相关：客户、PO、下单、确认（客户侧）、付款条款
    if (/业务|客户|po|下单|订单未|确认|样.*未确认|授权/.test(reason)) return 'sales';
    // 财务相关：付款、审批、定金、尾款、价格
    if (/财务|付款|定金|尾款|审批未通过|超预算|价格/.test(reason)) return 'finance';
    // 采购相关：面料、辅料、染色、到货、供应商
    if (/面料|辅料|染色|到货|供应商|布料|纱线|采购未/.test(reason)) return 'procurement';
    // 生产主管：产能、机台、排期、加工费、工厂未匹配
    if (/产能|机台|排期|加工费|工厂.*未|工厂.*没/.test(reason)) return 'production_manager';
    // QC：质量、不合格、返工、整改
    if (/质量|不合格|返工|整改|qc|验货/.test(reason)) return 'qc';
    return null;
  }

  const upstreamRole = inferUpstreamRole(blockedReason);
  const recipients: { user_id: string; email: string; name: string; reason: string }[] = [];

  // 1. 推断的 upstream 角色的人
  if (upstreamRole) {
    const { data: roleProfiles } = await supabase
      .from('profiles')
      .select('user_id, email, name, role, roles')
      .or(`role.eq.${upstreamRole},roles.cs.{${upstreamRole}}`);
    for (const p of (roleProfiles as any[] | null) || []) {
      if (p.email) {
        recipients.push({
          user_id: p.user_id,
          email: p.email,
          name: p.name || p.email,
          reason: `${upstreamRole} 角色（根据卡住原因路由）`,
        });
      }
    }
  }

  // 2. 兜底：订单创建者（业务）— 始终通知，因为是订单所有者
  try {
    const { data: creatorProfile } = await supabase
      .from('profiles')
      .select('user_id, email, name')
      .eq('user_id', orderData.created_by)
      .single();
    const cp = creatorProfile as any;
    if (cp?.email && !recipients.find(r => r.email === cp.email)) {
      recipients.push({
        user_id: cp.user_id,
        email: cp.email,
        name: cp.name || cp.email,
        reason: '订单创建者',
      });
    }
  } catch { /* ignore */ }

  if (recipients.length === 0) return { error: 'No recipients resolved' };

  // Check if already sent (within 24h to allow re-send)
  const recipientEmails = recipients.map(r => r.email);
  const { data: recent } = await supabase
    .from('notifications')
    .select('id, sent_to')
    .eq('milestone_id', milestoneId)
    .eq('kind', 'blocked')
    .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const alreadySent = new Set(((recent as any[] | null) || []).map(r => r.sent_to));
  const toNotify = recipients.filter(r => !alreadySent.has(r.email));
  if (toNotify.length === 0) return { data: { already_sent: true } };

  const ccEmails = MANAGER_CC_EMAILS;

  // Create notifications + 写应用内 notifications 表 + WeChat push
  const { pushToUsers } = await import('@/lib/utils/wechat-push');
  for (const r of toNotify) {
    await supabase.from('notifications').insert({
      milestone_id: milestoneId,
      order_id: orderId,
      kind: 'blocked',
      sent_to: r.email,
      sent_at: new Date().toISOString(),
      payload: {
        order_no: orderData.order_no,
        milestone_name: milestoneData.name,
        blocked_reason: blockedReason,
        route_reason: r.reason,
      },
    });

    // WeChat Work push
    try {
      await pushToUsers(
        supabase,
        [r.user_id],
        `[卡住] ${orderData.order_no} · ${milestoneData.name}`,
        `卡住原因：${blockedReason}\n你被指派处理（${r.reason}），请尽快推进或回复责任方。`,
      );
    } catch { /* ignore */ }
  }

  // Send email — 主接收人是 toNotify 全部，cc 是 manager
  const subject = `[卡住·需要你处理] ${orderData.order_no} - ${milestoneData.name}`;
  const body = `
    <h2 style="color:#d97706;">订单节点已卡住</h2>
    <p><strong>订单：</strong>${orderData.order_no}（${orderData.customer_name || '—'}）</p>
    <p><strong>节点：</strong>${milestoneData.name}</p>
    <p><strong>卡住原因：</strong>${blockedReason}</p>
    <p><strong>系统判断需要你协助处理</strong>（基于卡住原因关键词路由）。</p>
    <p>请尽快推进或在系统里回复责任方。<br>
    若需要他人配合，可在订单详情用「催办」功能 @ 对应同事。</p>
  `;

  await sendEmailNotification([...toNotify.map(r => r.email), ...ccEmails], subject, body);

  return { data: { sent: true, recipients: toNotify.length } };
}

/**
 * 交期预警邮件：actual_at 超 due_at 超过 3 天时发送
 */
/**
 * ⚠️ 鉴权（2026-05-19）：同 sendBlockedNotification — 'use server' 公开函数
 * 但只该被 updateMilestoneActualDate 内部调用；外部 RPC 端点需要堵
 */
export async function sendDeliveryDelayAlert(
  milestoneId: string,
  orderId: string,
  delayDays: number
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: callerProfile } = await supabase
    .from('profiles').select('roles, role').eq('user_id', user.id).single();
  const callerRoles: string[] = (callerProfile as any)?.roles?.length > 0
    ? (callerProfile as any).roles
    : [(callerProfile as any)?.role].filter(Boolean);
  const isAdmin = callerRoles.includes('admin');

  const { data: milestone } = await supabase
    .from('milestones').select('*').eq('id', milestoneId).single();
  if (!milestone) return { error: 'Milestone not found' };
  const m = milestone as any;
  if (m.order_id !== orderId) {
    return { error: 'milestone 与 orderId 不匹配' };
  }

  const { data: order } = await supabase
    .from('orders').select('*').eq('id', orderId).single();
  if (!order) return { error: 'Order not found' };

  // 鉴权：admin / milestone owner / order created_by / order owner_user_id
  if (!isAdmin) {
    const allowed =
      m.owner_user_id === user.id ||
      (order as any).created_by === user.id ||
      (order as any).owner_user_id === user.id;
    if (!allowed) {
      console.warn('[sendDeliveryDelayAlert] unauthorized call', { userId: user.id, milestoneId, orderId });
      return { error: '无权操作此节点' };
    }
  }
  const o = order as any;

  // 获取订单创建者邮箱
  let recipientEmail = '';
  try {
    const { data: profile } = await supabase
      .from('profiles').select('email').eq('user_id', o.created_by).single();
    recipientEmail = (profile as any)?.email || '';
  } catch { /* ignore */ }

  const ccEmails = MANAGER_CC_EMAILS;
  const kind = `delivery_delay_red`;

  // 去重：同一节点只发一次 RED 预警
  const { data: existing } = await supabase
    .from('notifications').select('id')
    .eq('milestone_id', milestoneId).eq('kind', kind)
    .eq('sent_to', recipientEmail || ccEmails[0]).single();
  if (existing) return { data: { already_sent: true } };

  // 写入通知记录
  await supabase.from('notifications').insert({
    milestone_id: milestoneId,
    order_id: orderId,
    kind,
    sent_to: recipientEmail || ccEmails[0],
    sent_at: new Date().toISOString(),
    payload: {
      order_no: o.order_no,
      milestone_name: m.name,
      delay_days: delayDays,
      actual_at: m.actual_at,
      due_at: m.due_at,
    },
  });

  // 发送邮件
  const subject = `[紧急] 订单 ${o.order_no} — ${m.name} 延迟 ${delayDays} 天，交期存在风险`;
  const body = `
    <h2 style="color: #dc2626;">交期风险预警</h2>
    <table style="border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 12px;font-weight:bold;">订单号</td><td style="padding:4px 12px;">${o.order_no}</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">客户</td><td style="padding:4px 12px;">${o.customer_name}</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">节点</td><td style="padding:4px 12px;">${m.name}</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">系统截止</td><td style="padding:4px 12px;">${m.due_at ? new Date(m.due_at).toLocaleDateString('zh-CN') : '-'}</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">实际/预计</td><td style="padding:4px 12px;color:#dc2626;font-weight:bold;">${m.actual_at ? new Date(m.actual_at).toLocaleDateString('zh-CN') : '-'}</td></tr>
      <tr><td style="padding:4px 12px;font-weight:bold;">延迟天数</td><td style="padding:4px 12px;color:#dc2626;font-weight:bold;">${delayDays} 天</td></tr>
    </table>
    <p>请立即采取措施，避免影响最终交货日期。</p>
    <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com'}/orders/${orderId}">查看订单详情</a></p>
  `;

  const allRecipients = recipientEmail ? [recipientEmail, ...ccEmails] : ccEmails;
  await sendEmailNotification(allRecipients, subject, body);

  return { data: { sent: true, delay_days: delayDays } };
}

/**
 * 检查关联了 milestone 的备忘录：
 * 如果关联的关卡 due_at 在 3 天内且 memo 没有手动设置 remind_at，
 * 则写入一条系统通知（notifications 表），提醒 memo 所有者。
 * 只读+创建通知，不修改任何 memo/milestone 数据。
 */
export async function checkLinkedMemoReminders() {
  const supabase = await createClient();
  const now = new Date();
  const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  // 查询：未完成的 memo + 关联了 milestone + milestone 还没完成
  const { data: memos, error } = await (supabase.from('user_memos') as any)
    .select('id, user_id, content, remind_at, order_id, milestone_id, linked_order_no')
    .eq('is_done', false)
    .not('milestone_id', 'is', null);

  if (error || !memos) return { error: error?.message, reminders_sent: 0 };

  let remindersSent = 0;

  for (const memo of memos as any[]) {
    // 如果用户手动设了 remind_at，跳过（用户自己管理提醒时间）
    if (memo.remind_at) continue;

    // 查关联的 milestone
    const { data: milestone } = await (supabase.from('milestones') as any)
      .select('id, name, due_at, status, order_id')
      .eq('id', memo.milestone_id)
      .single();

    if (!milestone) continue;
    const ms = milestone as any;

    // 已完成的关卡不提醒
    if (isDoneStatus(ms.status)) continue;

    // due_at 在 3 天内才提醒
    if (!ms.due_at) continue;
    const dueAt = new Date(ms.due_at);
    if (dueAt > threeDaysLater || dueAt < now) continue; // 超过3天或已逾期（逾期由其他系统处理）

    // 获取 memo 创建者的邮箱
    const { data: profile } = await (supabase.from('profiles') as any)
      .select('email')
      .eq('user_id', memo.user_id)
      .single();
    if (!profile?.email) continue;

    // 去重：同一个 memo + milestone 组合只发一次
    const notifKind = 'memo_milestone_remind';
    const { data: existing } = await (supabase.from('notifications') as any)
      .select('id')
      .eq('milestone_id', ms.id)
      .eq('kind', notifKind)
      .eq('sent_to', profile.email)
      .single();
    if (existing) continue;

    // 创建通知
    const orderNo = memo.linked_order_no || '未知订单';
    await (supabase.from('notifications') as any).insert({
      milestone_id: ms.id,
      order_id: ms.order_id,
      kind: notifKind,
      sent_to: profile.email,
      sent_at: now.toISOString(),
      payload: {
        memo_id: memo.id,
        memo_content: memo.content.slice(0, 100),
        order_no: orderNo,
        milestone_name: ms.name,
        due_at: ms.due_at,
      },
    });

    // 发送邮件
    const daysLeft = Math.ceil((dueAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const subject = `[备忘提醒] ${orderNo} — ${ms.name} 还有 ${daysLeft} 天到期`;
    const body = `
      <h2>备忘录关联节拍提醒</h2>
      <p><strong>您的备忘：</strong>${memo.content.slice(0, 200)}</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px;font-weight:bold;">关联订单</td><td style="padding:4px 12px;">${orderNo}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">执行环节</td><td style="padding:4px 12px;">${ms.name}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">截止日期</td><td style="padding:4px 12px;">${dueAt.toLocaleDateString('zh-CN')}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold;">剩余天数</td><td style="padding:4px 12px;color:#d97706;font-weight:bold;">${daysLeft} 天</td></tr>
      </table>
      <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com'}/orders/${ms.order_id}">查看订单详情</a></p>
    `;

    await sendEmailNotification([profile.email], subject, body);
    remindersSent++;
  }

  return { data: { checked: (memos as any[]).length, reminders_sent: remindersSent } };
}

/**
 * 定期扫描：检查所有已填 actual_at 的节点，触发交期预警
 * 供 cron job 调用
 */
export async function checkDeliveryDeadlines() {
  const supabase = await createClient();

  // 获取所有有 actual_at 且未完成的里程碑
  const { data: milestones, error } = await supabase
    .from('milestones')
    .select('id, order_id, step_key, name, due_at, actual_at, status')
    .not('actual_at', 'is', null)
    .not('status', 'eq', 'done');

  if (error || !milestones) return { error: error?.message };

  let alertsSent = 0;
  for (const m of milestones as any[]) {
    if (!m.actual_at || !m.due_at) continue;
    const diffMs = new Date(m.actual_at).getTime() - new Date(m.due_at).getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays > 3) {
      const result = await sendDeliveryDelayAlert(m.id, m.order_id, diffDays);
      if (result.data && !('already_sent' in result.data)) alertsSent++;
    }
  }

  return { data: { checked: milestones.length, alerts_sent: alertsSent } };
}
