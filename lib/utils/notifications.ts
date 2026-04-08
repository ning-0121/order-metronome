import nodemailer from 'nodemailer';
import { createClient } from '../supabase/server';
import { shouldSendEmail as policyShouldSendEmail, getTier } from '../domain/notification-policy';

/** HTML转义：防止XSS注入到邮件模板 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 管理层抄送邮箱（集中管理，避免硬编码分散各处）
 * 可通过环境变量 MANAGER_CC_EMAILS 覆盖，逗号分隔
 */
export const MANAGER_CC_EMAILS: string[] = (
  process.env.MANAGER_CC_EMAILS || 'su@qimoclothing.com,alex@qimoclothing.com'
).split(',').map(e => e.trim()).filter(Boolean);

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
 * Returns { sent: true } on success, { sent: false, reason: string } on failure
 */
export async function sendEmailNotification(
  to: string | string[],
  subject: string,
  html: string
): Promise<boolean> {
  try {
    // 🔴 全局邮件 kill-switch (CEO 2026-04-09：防止邮件爆炸)
    // Vercel 环境变量设 EMAIL_NOTIFICATIONS_DISABLED=true 即可全量关停
    if (process.env.EMAIL_NOTIFICATIONS_DISABLED === 'true') {
      console.log('[SMTP] 已全局暂停（EMAIL_NOTIFICATIONS_DISABLED=true），跳过：', subject);
      return false;
    }

    if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
      console.error('[SMTP] SMTP_USER or SMTP_PASSWORD not configured');
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
 *
 * 通知频率策略：
 * - sendEmail 参数留作显式覆盖（true = 强制发邮件，false = 强制不发）
 * - 默认 undefined：交给 lib/domain/notification-policy 决定
 *   · URGENT 类型 → 立即发邮件（延期审批、价格审批、阻塞等）
 *   · DIGEST 类型 → 只站内，邮件合并到早 8 点每日简报
 *   · STATION_ONLY → 永不邮件
 */
export async function sendNotification(
  userId: string,
  userEmail: string,
  type: string,
  title: string,
  message: string,
  relatedOrderId?: string,
  relatedMilestoneId?: string,
  sendEmail?: boolean,
): Promise<void> {
  // Create in-app notification
  await createInAppNotification(userId, type, title, message, relatedOrderId, relatedMilestoneId);

  // 决定是否发邮件：显式覆盖 > 策略表
  const effectiveSendEmail = sendEmail !== undefined
    ? sendEmail
    : policyShouldSendEmail(type);

  if (!effectiveSendEmail) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[notify] ${type} (${getTier(type)}) — 站内 only, 邮件跳过`);
    }
    return;
  }

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
