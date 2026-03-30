import nodemailer from 'nodemailer';
import { createClient } from '../supabase/server';

/**
 * Create SMTP transporter for Tencent enterprise mail
 */
function createEmailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.exmail.qq.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

/**
 * Send email notification
 */
export async function sendEmailNotification(
  to: string | string[],
  subject: string,
  html: string
): Promise<boolean> {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
      console.warn('SMTP not configured, skipping email send');
      return false;
    }

    const transporter = createEmailTransporter();
    const recipients = Array.isArray(to) ? to : [to];
    
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(', '),
      subject,
      html,
    });
    
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

/**
 * Create in-app notification
 * Note: This should be called from server actions, not client components
 */
export async function createInAppNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  relatedOrderId?: string,
  relatedMilestoneId?: string
): Promise<void> {
  const supabase = await createClient();
  
  const { error } = await (supabase.from('notifications') as any).insert({
    user_id: userId,
    type,
    title,
    message,
    related_order_id: relatedOrderId || null,
    related_milestone_id: relatedMilestoneId || null,
    status: 'unread',
    email_sent: false,
  });
  
  if (error) {
    console.error('Error creating notification:', error);
  }
}

/**
 * Send notification (email + in-app)
 */
export async function sendNotification(
  userId: string,
  userEmail: string,
  type: string,
  title: string,
  message: string,
  relatedOrderId?: string,
  relatedMilestoneId?: string,
  sendEmail: boolean = true
): Promise<void> {
  // Create in-app notification
  await createInAppNotification(userId, type, title, message, relatedOrderId, relatedMilestoneId);
  
  // Send email if enabled
  if (sendEmail) {
    const emailSent = await sendEmailNotification(userEmail, title, message);
    
    // Update notification with email status
    if (emailSent) {
      const supabase = await createClient();
      const { data: notifications } = await (supabase
        .from('notifications') as any)
        .select('id')
        .eq('user_id', userId)
        .eq('type', type)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (notifications) {
        await (supabase
          .from('notifications') as any)
          .update({ email_sent: true })
          .eq('id', (notifications as any).id);
      }
    }
  }
}

/**
 * Send escalation notifications for overdue/blocked milestones
 */
export async function sendEscalationNotifications(
  orderId: string,
  milestoneId: string,
  orderNo: string,
  reason: string
): Promise<void> {
  const escalationEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];
  const subject = `⚠️ 订单 ${orderNo} 里程碑异常`;
  const html = `
    <h2>订单里程碑异常</h2>
    <p><strong>订单号:</strong> ${orderNo}</p>
    <p><strong>原因:</strong> ${reason}</p>
    <p>请及时处理。</p>
  `;
  
  await sendEmailNotification(escalationEmails, subject, html);
}

/**
 * Send reminder notifications (48/24/12 hours before due)
 */
export async function sendReminderNotifications(
  milestoneId: string,
  userId: string,
  userEmail: string,
  milestoneName: string,
  orderNo: string,
  dueAt: Date,
  hoursBefore: number
): Promise<void> {
  const subject = `⏰ 提醒: ${orderNo} - ${milestoneName} 即将到期`;
  const message = `订单 ${orderNo} 的里程碑 "${milestoneName}" 将在 ${hoursBefore} 小时后到期，请及时处理。`;
  
  await sendNotification(
    userId,
    userEmail,
    'reminder',
    subject,
    message,
    undefined,
    milestoneId,
    true
  );
}
