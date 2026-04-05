'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';
import { generateOrderNo } from '@/lib/repositories/ordersRepo';
import { getApplicableMilestones } from '@/lib/milestoneTemplate';
import { calcDueDates } from '@/lib/schedule';
import { ensureBusinessDay } from '@/lib/utils/date';

/** 报价审批通过 */
export async function approveQuote(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权操作：只有管理员可以审批报价' };

  const { error } = await (supabase.from('orders') as any)
    .update({ quote_status: 'approved', quote_approved_by: user.id, quote_approved_at: new Date().toISOString() })
    .eq('id', orderId).eq('quote_status', 'pending');
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/quotes');
  return {};
}

/** 报价驳回 */
export async function rejectQuote(orderId: string, reason?: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权操作' };

  const { error } = await (supabase.from('orders') as any)
    .update({ quote_status: 'rejected', quote_approved_by: user.id, quote_approved_at: new Date().toISOString() })
    .eq('id', orderId).eq('quote_status', 'pending');
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/quotes');
  return {};
}

/** 创建报价单（询价） */
export async function createInquiry(data: {
  customer_name: string;
  customer_id: string;
  product_description: string;
  quantity?: number;
  target_price?: string;
  notes?: string;
  incoterm?: string;
}): Promise<{ error?: string; orderId?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!data.customer_name) return { error: '请选择客户' };
  if (!data.product_description) return { error: '请填写产品描述' };

  const { orderNo, error: noErr } = await generateOrderNo();
  if (noErr || !orderNo) return { error: noErr || '订单号生成失败' };

  const { data: order, error } = await (supabase.from('orders') as any)
    .insert({
      order_no: orderNo,
      customer_name: data.customer_name,
      customer_id: data.customer_id,
      product_description: data.product_description,
      quantity: data.quantity || null,
      target_price: data.target_price || null,
      notes: data.notes || null,
      incoterm: data.incoterm || 'FOB',
      order_type: 'sample',
      order_purpose: 'inquiry',
      quote_status: 'pending',
      lifecycle_status: '草稿',
      created_by: user.id,
      owner_user_id: user.id,
    })
    .select('id')
    .single();

  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return { orderId: order?.id };
}

/** 从报价创建打样单 */
export async function createSampleFromQuote(quoteOrderId: string): Promise<{ error?: string; sampleId?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 获取报价单
  const { data: quote } = await (supabase.from('orders') as any)
    .select('*').eq('id', quoteOrderId).single();
  if (!quote) return { error: '报价单不存在' };
  if (quote.quote_status !== 'approved') return { error: '报价未通过审批' };

  const { orderNo, error: noErr } = await generateOrderNo();
  if (noErr || !orderNo) return { error: noErr || '订单号生成失败' };

  // 创建打样单
  const sampleDate = new Date();
  sampleDate.setDate(sampleDate.getDate() + 14); // 14天后

  const { data: sample, error } = await (supabase.from('orders') as any)
    .insert({
      order_no: orderNo,
      customer_name: quote.customer_name,
      customer_id: quote.customer_id,
      product_description: quote.product_description,
      quantity: Math.min(quote.quantity || 100, 500), // 打样数量取小值
      target_price: quote.target_price,
      notes: `打样单（关联报价：${quote.order_no}）`,
      incoterm: quote.incoterm || 'FOB',
      order_type: 'sample',
      order_purpose: 'sample',
      parent_order_id: quoteOrderId,
      sample_status: 'pending',
      lifecycle_status: '执行中',
      factory_date: sampleDate.toISOString().slice(0, 10),
      created_by: user.id,
      owner_user_id: user.id,
    })
    .select('id')
    .single();

  if (error) return { error: error.message };

  // 生成打样里程碑
  try {
    const templates = getApplicableMilestones('sample', false, 'domestic', 'sample');
    const dueDates = calcDueDates({
      createdAt: new Date(),
      incoterm: 'FOB',
      etd: sampleDate.toISOString().slice(0, 10),
    });

    const milestonesData = templates.map((t, i) => ({
      step_key: t.step_key,
      name: t.name,
      owner_role: t.owner_role,
      owner_user_id: t.owner_role === 'sales' ? user.id : null,
      planned_at: ensureBusinessDay(dueDates[t.step_key as keyof typeof dueDates] || new Date()).toISOString(),
      due_at: ensureBusinessDay(dueDates[t.step_key as keyof typeof dueDates] || new Date()).toISOString(),
      status: i === 0 ? 'in_progress' : 'pending',
      is_critical: t.is_critical,
      evidence_required: t.evidence_required,
      sequence_number: i + 1,
    }));

    await (supabase.rpc as any)('init_order_milestones', {
      _order_id: sample.id,
      _milestones_data: milestonesData,
    });
  } catch (e: any) {
    console.error('[createSampleFromQuote] milestone error:', e?.message);
  }

  revalidatePath('/quotes');
  revalidatePath('/orders');
  return { sampleId: sample?.id };
}

/** 从打样创建正式订单（跳转到新建订单页，预填信息） */
export async function getSampleDataForOrder(sampleOrderId: string): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: sample } = await (supabase.from('orders') as any)
    .select('*').eq('id', sampleOrderId).single();
  if (!sample) return { error: '打样单不存在' };
  if (sample.sample_status !== 'approved') return { error: '打样未通过客户确认' };

  return { data: { customer_name: sample.customer_name, customer_id: sample.customer_id, factory_name: sample.factory_name, factory_id: sample.factory_id, product_description: sample.product_description, parent_order_id: sampleOrderId } };
}
