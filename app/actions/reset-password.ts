'use server';

import crypto from 'crypto';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { sendEmailNotification } from '@/lib/utils/notifications';

// Use a dedicated secret for HMAC signing. Falls back to service role key (server-only, never public).
const SECRET = process.env.RESET_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Generate a signed reset token (HMAC-based, no DB needed)
 * Token = base64(userId:timestamp:signature)
 * Valid for 1 hour
 */
function generateResetToken(userId: string): string {
  const ts = Date.now().toString();
  const payload = `${userId}:${ts}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

/**
 * Verify a reset token
 * Returns userId if valid, null if invalid/expired
 */
function verifyResetToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;

    const [userId, ts, sig] = parts;

    // Check expiry (1 hour)
    const tokenAge = Date.now() - parseInt(ts);
    if (tokenAge > 60 * 60 * 1000) return null;

    // Verify signature
    const expectedSig = crypto.createHmac('sha256', SECRET).update(`${userId}:${ts}`).digest('hex');
    if (sig !== expectedSig) return null;

    return userId;
  } catch {
    return null;
  }
}

/**
 * Send password reset email (custom flow, bypasses Supabase PKCE)
 */
export async function sendPasswordResetEmail(email: string): Promise<{ error?: string; success?: boolean }> {
  if (!email || !email.endsWith('@qimoclothing.com')) {
    return { error: '仅允许 @qimoclothing.com 邮箱' };
  }

  try {
    // Find user by email using service role client
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      return { error: '系统配置错误，请联系管理员' };
    }

    const adminClient = createSupabaseClient(url, serviceKey);

    // Look up user in auth.users via admin API
    const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers();
    if (listError) {
      console.error('[reset-password] listUsers error:', listError);
      return { error: '系统错误，请稍后重试' };
    }

    const user = users.find(u => u.email === email);
    if (!user) {
      // Don't reveal whether user exists — still show success
      return { success: true };
    }

    // Generate signed token
    const token = generateResetToken(user.id);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://order.qimoactivewear.com';
    const resetLink = `${appUrl}/auth/reset-password?token=${token}`;

    // Send email via our own SMTP
    const userName = user.user_metadata?.name || user.user_metadata?.full_name || email.split('@')[0];
    const sent = await sendEmailNotification(
      email,
      '【订单节拍器】密码重置',
      `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #1a1a2e; margin: 0;">订单节拍器</h2>
          <p style="color: #666; font-size: 14px;">密码重置请求</p>
        </div>

        <p style="color: #333; font-size: 14px;">你好 ${userName}，</p>
        <p style="color: #333; font-size: 14px;">我们收到了你的密码重置请求。点击下方按钮设置新密码：</p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetLink}"
             style="display: inline-block; background: #4f46e5; color: white; padding: 12px 32px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 14px;">
            重置密码
          </a>
        </div>

        <p style="color: #999; font-size: 12px;">此链接有效期为 1 小时。如果你没有请求重置密码，请忽略此邮件。</p>
        <p style="color: #999; font-size: 12px;">如果按钮无法点击，请复制以下链接到浏览器：</p>
        <p style="color: #4f46e5; font-size: 11px; word-break: break-all;">${resetLink}</p>

        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #bbb; font-size: 11px; text-align: center;">订单节拍器 · 绮陌科技</p>
      </div>
      `
    );

    if (!sent) {
      return { error: '邮件发送失败，请稍后重试' };
    }

    return { success: true };
  } catch (err: any) {
    console.error('[reset-password] sendPasswordResetEmail error:', err);
    return { error: '操作失败，请稍后重试' };
  }
}

/**
 * Reset password using signed token (called from API route)
 */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<{ error?: string; success?: boolean }> {
  if (!newPassword || newPassword.length < 8) {
    return { error: '密码至少需要 8 位' };
  }

  const userId = verifyResetToken(token);
  if (!userId) {
    return { error: '重置链接已失效或无效，请重新发送重置邮件' };
  }

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      return { error: '系统配置错误，请联系管理员' };
    }

    const adminClient = createSupabaseClient(url, serviceKey);
    const { error } = await adminClient.auth.admin.updateUserById(userId, { password: newPassword });

    if (error) {
      console.error('[reset-password] admin updateUser error:', error);
      return { error: '密码更新失败：' + error.message };
    }

    return { success: true };
  } catch (err: any) {
    console.error('[reset-password] resetPasswordWithToken error:', err);
    return { error: '操作失败，请重试' };
  }
}
