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
    .in('status', ['in_progress', '进行中']);

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
