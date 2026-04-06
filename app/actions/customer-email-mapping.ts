'use server';

import { createClient } from '@/lib/supabase/server';

export interface EmailDomainMapping {
  id: string;
  customer_name: string;
  email_domain: string;
  sample_email: string | null;
  created_at: string;
}

/**
 * 获取某客户的所有邮箱域名映射
 */
export async function getCustomerEmailDomains(
  customerName: string
): Promise<{ data: EmailDomainMapping[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('customer_email_domains') as any)
    .select('id, customer_name, email_domain, sample_email, created_at')
    .eq('customer_name', customerName)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 获取所有客户邮箱映射（管理页面用）
 */
export async function getAllEmailDomains(): Promise<{ data: EmailDomainMapping[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('customer_email_domains') as any)
    .select('id, customer_name, email_domain, sample_email, created_at')
    .order('customer_name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 手动添加客户邮箱域名映射
 */
export async function addEmailDomainMapping(
  customerName: string,
  emailDomain: string,
  sampleEmail?: string,
): Promise<{ data: EmailDomainMapping | null; error: string | null }> {
  if (!customerName?.trim()) return { data: null, error: '客户名称不能为空' };
  if (!emailDomain?.trim()) return { data: null, error: '邮箱域名不能为空' };

  // 清理域名：去掉 @前缀 和空格
  let domain = emailDomain.trim().toLowerCase();
  if (domain.includes('@')) {
    domain = domain.split('@').pop() || domain;
  }
  // 基本验证
  if (!domain.includes('.')) return { data: null, error: '请输入有效的邮箱域名，如 example.com' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('customer_email_domains') as any)
    .upsert({
      customer_name: customerName.trim(),
      email_domain: domain,
      sample_email: sampleEmail?.trim() || null,
    }, { onConflict: 'customer_name,email_domain' })
    .select('id, customer_name, email_domain, sample_email, created_at')
    .single();

  if (error) {
    if (error.code === '23505') return { data: null, error: '该域名已绑定到此客户' };
    return { data: null, error: error.message };
  }
  return { data, error: null };
}

/**
 * 删除客户邮箱域名映射
 */
export async function removeEmailDomainMapping(
  mappingId: string
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('customer_email_domains') as any)
    .delete()
    .eq('id', mappingId);

  if (error) return { error: error.message };
  return { error: null };
}

/**
 * 获取订单关联的邮件列表（含线索追踪）
 */
export async function getOrderEmails(orderId: string): Promise<{
  data: Array<{
    id: string;
    from_email: string;
    subject: string;
    raw_body: string;
    received_at: string;
    customer_id: string | null;
    extracted_po: string | null;
    thread_id: string | null;
  }> | null;
  error: string | null;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, raw_body, received_at, customer_id, extracted_po, thread_id')
    .eq('order_id', orderId)
    .order('received_at', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 获取客户所有邮件（用于追溯订单起源）
 */
export async function getCustomerEmails(customerName: string, limit = 50): Promise<{
  data: Array<{
    id: string;
    from_email: string;
    subject: string;
    received_at: string;
    order_id: string | null;
    extracted_po: string | null;
    thread_id: string | null;
  }> | null;
  error: string | null;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, received_at, order_id, extracted_po, thread_id')
    .eq('customer_id', customerName)
    .order('received_at', { ascending: false })
    .limit(limit);

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 手动将一封邮件关联到某个订单
 */
export async function linkEmailToOrder(
  emailId: string,
  orderId: string,
  customerName?: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const updateData: Record<string, string> = { order_id: orderId };
  if (customerName) updateData.customer_id = customerName;

  const { error } = await (supabase.from('mail_inbox') as any)
    .update(updateData)
    .eq('id', emailId);

  if (error) return { error: error.message };
  return { error: null };
}

/**
 * 手动将邮件地址绑定到客户（从邮件列表一键绑定）
 */
export async function bindEmailToCustomer(
  fromEmail: string,
  customerName: string,
): Promise<{ error: string | null }> {
  if (!fromEmail || !customerName) return { error: '参数不完整' };

  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) return { error: '邮箱地址格式不正确' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 1. 添加域名映射
  await (supabase.from('customer_email_domains') as any)
    .upsert({
      customer_name: customerName,
      email_domain: domain,
      sample_email: fromEmail,
    }, { onConflict: 'customer_name,email_domain' });

  // 2. 更新该域名所有未关联的邮件
  await (supabase.from('mail_inbox') as any)
    .update({ customer_id: customerName })
    .ilike('from_email', `%@${domain}`)
    .is('customer_id', null);

  return { error: null };
}
