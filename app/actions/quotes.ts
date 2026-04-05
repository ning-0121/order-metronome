'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';
import { generateOrderNo } from '@/lib/repositories/ordersRepo';
import { getApplicableMilestones } from '@/lib/milestoneTemplate';
import { calcDueDates } from '@/lib/schedule';
import { ensureBusinessDay } from '@/lib/utils/date';

// ══════ 报价状态机 ══════

const STAGE_LABELS: Record<string, string> = {
  draft: '草稿', pending_review: '待审批', approved: 'CEO已通过',
  sent_to_customer: '已发客户', customer_accepted: '客户接受',
  customer_revision: '客户要修改', customer_rejected: '客户放弃',
  sample_created: '已创建打样', order_created: '已下单',
};

// ══════ 创建报价单 ══════

export async function createInquiry(data: {
  customer_name: string; customer_id: string; product_description: string;
  quantity?: number; target_price?: string; notes?: string; incoterm?: string;
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
      order_no: orderNo, customer_name: data.customer_name, customer_id: data.customer_id,
      product_description: data.product_description, quantity: data.quantity || null,
      target_price: data.target_price || null, notes: data.notes || null,
      incoterm: data.incoterm || 'FOB', order_type: 'sample',
      order_purpose: 'inquiry', quote_status: 'pending', quote_stage: 'draft',
      lifecycle_status: '草稿', created_by: user.id, owner_user_id: user.id,
    }).select('id').single();

  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return { orderId: order?.id };
}

// ══════ 阶段推进 ══════

/** 提交审批：draft → pending_review */
export async function submitQuoteForReview(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('orders') as any)
    .update({ quote_stage: 'pending_review', quote_status: 'pending' })
    .eq('id', orderId).in('quote_stage', ['draft', 'customer_revision']);
  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return {};
}

/** CEO审批通过：pending_review → approved */
export async function approveQuote(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅CEO/管理员可审批' };

  const { error } = await (supabase.from('orders') as any)
    .update({ quote_stage: 'approved', quote_status: 'approved', quote_approved_by: user.id, quote_approved_at: new Date().toISOString() })
    .eq('id', orderId).eq('quote_stage', 'pending_review');
  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return {};
}

/** CEO驳回：pending_review → draft */
export async function rejectQuote(orderId: string, reason?: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅CEO/管理员可驳回' };

  const { error } = await (supabase.from('orders') as any)
    .update({ quote_stage: 'draft', quote_status: 'rejected', notes: reason ? `[驳回] ${reason}` : null })
    .eq('id', orderId).eq('quote_stage', 'pending_review');
  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return {};
}

/** 标记已发客户：approved → sent_to_customer */
export async function markQuoteSent(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('orders') as any)
    .update({ quote_stage: 'sent_to_customer' })
    .eq('id', orderId).eq('quote_stage', 'approved');
  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return {};
}

/** 记录客户反馈 */
export async function recordCustomerFeedback(orderId: string, feedback: 'accepted' | 'revision' | 'rejected', note?: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const stageMap = { accepted: 'customer_accepted', revision: 'customer_revision', rejected: 'customer_rejected' };
  const updates: Record<string, any> = { quote_stage: stageMap[feedback] };
  if (note) updates.notes = note;

  const { error } = await (supabase.from('orders') as any)
    .update(updates).eq('id', orderId).eq('quote_stage', 'sent_to_customer');
  if (error) return { error: error.message };
  revalidatePath('/quotes');
  return {};
}

// ══════ 从报价创建打样单 ══════

export async function createSampleFromQuote(quoteOrderId: string): Promise<{ error?: string; sampleId?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: quote } = await (supabase.from('orders') as any).select('*').eq('id', quoteOrderId).single();
  if (!quote) return { error: '报价单不存在' };
  if (!['customer_accepted', 'approved'].includes(quote.quote_stage)) return { error: '报价未通过审批或客户未接受' };

  const { orderNo, error: noErr } = await generateOrderNo();
  if (noErr || !orderNo) return { error: noErr || '订单号生成失败' };

  const sampleDate = new Date();
  sampleDate.setDate(sampleDate.getDate() + 14);

  const { data: sample, error } = await (supabase.from('orders') as any)
    .insert({
      order_no: orderNo, customer_name: quote.customer_name, customer_id: quote.customer_id,
      product_description: quote.product_description, quantity: Math.min(quote.quantity || 100, 500),
      target_price: quote.target_price, notes: `打样单（关联报价：${quote.order_no}）`,
      incoterm: quote.incoterm || 'FOB', order_type: 'sample', order_purpose: 'sample',
      parent_order_id: quoteOrderId, sample_status: 'pending', lifecycle_status: '执行中',
      factory_date: sampleDate.toISOString().slice(0, 10), created_by: user.id, owner_user_id: user.id,
    }).select('id').single();
  if (error) return { error: error.message };

  // 更新报价单状态
  await (supabase.from('orders') as any).update({ quote_stage: 'sample_created' }).eq('id', quoteOrderId);

  // 生成打样里程碑
  try {
    const templates = getApplicableMilestones('sample', false, 'domestic', 'sample');
    const dueDates = calcDueDates({ createdAt: new Date(), incoterm: 'FOB', etd: sampleDate.toISOString().slice(0, 10) });
    const milestonesData = templates.map((t, i) => ({
      step_key: t.step_key, name: t.name, owner_role: t.owner_role,
      owner_user_id: t.owner_role === 'sales' ? user.id : null,
      planned_at: ensureBusinessDay(dueDates[t.step_key as keyof typeof dueDates] || new Date()).toISOString(),
      due_at: ensureBusinessDay(dueDates[t.step_key as keyof typeof dueDates] || new Date()).toISOString(),
      status: i === 0 ? 'in_progress' : 'pending', is_critical: t.is_critical,
      evidence_required: t.evidence_required, sequence_number: i + 1,
    }));
    await (supabase.rpc as any)('init_order_milestones', { _order_id: sample.id, _milestones_data: milestonesData });
  } catch (e: any) { console.error('[createSampleFromQuote]', e?.message); }

  revalidatePath('/quotes');
  revalidatePath('/orders');
  return { sampleId: sample?.id };
}

// ══════ 查询 ══════

export { STAGE_LABELS };
