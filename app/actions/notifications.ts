'use server';

import { createClient } from '@/lib/supabase/server';
import { sendEmailNotification } from '@/lib/utils/notifications';
import { differenceInHours } from 'date-fns';

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

    const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];

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
    }
  }

  return { data: results };
}

async function checkAndSendNotification(
  supabase: any,
  milestoneId: string,
  orderId: string,
  kind: 'remind_48' | 'remind_24' | 'remind_12' | 'overdue' | 'blocked',
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

  // Send email
  const urgency = kind === 'overdue' ? 'URGENT' : hoursRemaining <= 12 ? 'HIGH' : 'MEDIUM';
  const subject = `[${urgency}] Order ${orderNo} - ${milestoneName} ${kind === 'overdue' ? 'OVERDUE' : `Due in ${hoursRemaining}h`}`;
  
  const body = `
    <h2>Milestone Reminder</h2>
    <p><strong>Order:</strong> ${orderNo}</p>
    <p><strong>Milestone:</strong> ${milestoneName}</p>
    <p><strong>Due Date:</strong> ${dueAt.toLocaleString()}</p>
    <p><strong>Time Remaining:</strong> ${hoursRemaining < 0 ? 'OVERDUE' : `${hoursRemaining} hours`}</p>
    ${evidenceRequired ? '<p><strong>⚠️ Evidence Required</strong></p>' : ''}
    <p>Please take action to ensure this milestone is completed on time.</p>
  `;

  const allRecipients = [recipientEmail, ...ccEmails];
  await sendEmailNotification(allRecipients, subject, body);

  return true;
}

/**
 * Send blocked notification immediately when milestone is blocked
 */
export async function sendBlockedNotification(
  milestoneId: string,
  orderId: string,
  blockedReason: string
) {
  const supabase = await createClient();

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
    return { error: 'Creator email not found' };
  }
  
  if (!recipientEmail) return { error: 'Creator email not found' };

  const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];

  // Check if already sent
  const { data: existing } = await supabase
    .from('notifications')
    .select('id')
    .eq('milestone_id', milestoneId)
    .eq('kind', 'blocked')
    .eq('sent_to', recipientEmail)
    .single();

  if (existing) {
    return { data: { already_sent: true } };
  }

  // Create notification
  const insertPayload: any = {
    milestone_id: milestoneId,
    order_id: orderId,
    kind: 'blocked',
    sent_to: recipientEmail,
    sent_at: new Date().toISOString(),
    payload: {
      order_no: orderData.order_no,
      milestone_name: milestoneData.name,
      blocked_reason: blockedReason,
    },
  };
  await supabase.from('notifications').insert(insertPayload);

  // Send email
  const subject = `[URGENT] Order ${orderData.order_no} - ${milestoneData.name} BLOCKED`;
  const body = `
    <h2>Milestone Blocked</h2>
    <p><strong>Order:</strong> ${orderData.order_no}</p>
    <p><strong>Milestone:</strong> ${milestoneData.name}</p>
    <p><strong>Blocked Reason:</strong> ${blockedReason}</p>
    <p>Please take immediate action to resolve this issue.</p>
  `;

  await sendEmailNotification([recipientEmail, ...ccEmails], subject, body);

  return { data: { sent: true } };
}

/**
 * 交期预警邮件：actual_at 超 due_at 超过 3 天时发送
 */
export async function sendDeliveryDelayAlert(
  milestoneId: string,
  orderId: string,
  delayDays: number
) {
  const supabase = await createClient();

  const { data: milestone } = await supabase
    .from('milestones').select('*').eq('id', milestoneId).single();
  if (!milestone) return { error: 'Milestone not found' };
  const m = milestone as any;

  const { data: order } = await supabase
    .from('orders').select('*').eq('id', orderId).single();
  if (!order) return { error: 'Order not found' };
  const o = order as any;

  // 获取订单创建者邮箱
  let recipientEmail = '';
  try {
    const { data: profile } = await supabase
      .from('profiles').select('email').eq('user_id', o.created_by).single();
    recipientEmail = (profile as any)?.email || '';
  } catch { /* ignore */ }

  const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];
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
    <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://order-metronome.vercel.app'}/orders/${orderId}">查看订单详情</a></p>
  `;

  const allRecipients = recipientEmail ? [recipientEmail, ...ccEmails] : ccEmails;
  await sendEmailNotification(allRecipients, subject, body);

  return { data: { sent: true, delay_days: delayDays } };
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
