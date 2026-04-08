'use server';

/**
 * 客户联系邮箱管理 — 业务手动补充客户的邮箱地址
 *
 * 数据存在 customers.contact_emails text[] 字段
 * email-scan 识别 from_email 时优先按这个表精确匹配（绕过 AI 识别）
 */

import { createClient } from '@/lib/supabase/server';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 获取某个客户的所有联系邮箱
 */
export async function getCustomerContactEmails(customerName: string): Promise<{
  data?: string[];
  error?: string;
}> {
  if (!customerName) return { error: '客户名称为空' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data, error } = await (supabase.from('customers') as any)
    .select('contact_emails')
    .eq('customer_name', customerName)
    .maybeSingle();

  if (error) return { error: error.message };
  return { data: (data?.contact_emails as string[]) || [] };
}

/**
 * 添加一个联系邮箱
 */
export async function addCustomerContactEmail(
  customerName: string,
  email: string,
): Promise<{ data?: string[]; error?: string }> {
  if (!customerName || !email) return { error: '参数不完整' };

  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed)) {
    return { error: '邮箱格式不正确' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 读取当前列表
  const { data: row } = await (supabase.from('customers') as any)
    .select('id, contact_emails')
    .eq('customer_name', customerName)
    .maybeSingle();

  if (!row) {
    return { error: '客户不存在 — 请先在客户管理中创建' };
  }

  const current: string[] = (row.contact_emails as string[]) || [];
  if (current.includes(trimmed)) {
    return { error: '该邮箱已在列表中' };
  }

  const updated = [...current, trimmed];

  const { error: updErr } = await (supabase.from('customers') as any)
    .update({ contact_emails: updated })
    .eq('id', row.id);

  if (updErr) return { error: updErr.message };
  return { data: updated };
}

/**
 * 删除一个联系邮箱
 */
export async function removeCustomerContactEmail(
  customerName: string,
  email: string,
): Promise<{ data?: string[]; error?: string }> {
  if (!customerName || !email) return { error: '参数不完整' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: row } = await (supabase.from('customers') as any)
    .select('id, contact_emails')
    .eq('customer_name', customerName)
    .maybeSingle();
  if (!row) return { error: '客户不存在' };

  const current: string[] = (row.contact_emails as string[]) || [];
  const updated = current.filter(e => e !== email);

  const { error: updErr } = await (supabase.from('customers') as any)
    .update({ contact_emails: updated })
    .eq('id', row.id);

  if (updErr) return { error: updErr.message };
  return { data: updated };
}
