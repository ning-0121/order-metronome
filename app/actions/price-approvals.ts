'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';

/**
 * 订单创建前的价格审批
 *
 * 流程：
 *  1. 业务员提交订单 → AI 比对三单价格
 *  2. 价格不一致 → 业务员调用 requestPriceApproval 推送 CEO
 *  3. CEO 在 /admin/price-approvals 审批
 *  4. 业务员看到批准后重新提交订单（带 approval_id）
 *  5. createOrder 校验 approval_id 状态 = approved + 24h 内 + 同一申请人
 */

export interface PriceDiff {
  field: string;
  internalValue: string;
  customerQuoteValue: string;
  poValue: string;
  note?: string;
}

/**
 * 推送价格审批申请
 */
export async function requestPriceApproval(payload: {
  customer_name?: string;
  po_number?: string;
  form_snapshot: Record<string, any>;
  price_diffs: PriceDiff[];
  summary?: string;
}): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  if (!Array.isArray(payload.price_diffs) || payload.price_diffs.length === 0) {
    return { error: '没有价格差异，无需审批' };
  }

  const { data, error } = await (supabase.from('pre_order_price_approvals') as any)
    .insert({
      requested_by: user.id,
      customer_name: payload.customer_name || null,
      po_number: payload.po_number || null,
      form_snapshot: payload.form_snapshot || {},
      price_diffs: payload.price_diffs,
      summary: payload.summary || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) return { error: error.message };

  revalidatePath('/admin/price-approvals');
  return { id: (data as any).id };
}

/**
 * CEO 审批价格申请（批准 / 驳回）
 */
export async function approvePriceApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员/CEO 可审批价格' };

  const { data: row } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id, status, requested_by, customer_name, po_number')
    .eq('id', approvalId)
    .single();
  if (!row) return { error: '审批记录不存在' };
  if (row.status !== 'pending') return { error: `该申请已是「${row.status}」状态，无法重复审批` };

  const { error } = await (supabase.from('pre_order_price_approvals') as any)
    .update({
      status: decision,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note || null,
    })
    .eq('id', approvalId);

  if (error) return { error: error.message };

  // ── 通知申请人 ──
  const requesterId = (row as any).requested_by;
  const customerLabel = `${(row as any).customer_name || '?'} · PO ${(row as any).po_number || '?'}`;
  const decisionEmoji = decision === 'approved' ? '✅' : '❌';
  const decisionText = decision === 'approved' ? '已批准' : '已驳回';
  const title = `${decisionEmoji} 价格审批${decisionText} — ${customerLabel}`;
  const message = decision === 'approved'
    ? `CEO 已批准该订单的价格差异。请回到「新建订单」表单点「✓ CEO 已批准，继续创建」。${note ? '\n备注：' + note : ''}`
    : `CEO 驳回原因：${note || '无'}\n请联系客户修改 PO 后重新申请。`;

  // 站内通知
  try {
    await (supabase.from('notifications') as any).insert({
      user_id: requesterId,
      type: 'price_approval',
      title,
      message,
    });
  } catch {}

  // 企业微信推送
  try {
    const { pushToUsers } = await import('@/lib/utils/wechat-push');
    await pushToUsers(supabase, [requesterId], title, message);
  } catch {}

  revalidatePath('/admin/price-approvals');
  return {};
}

/**
 * 仅返回待审批数量（用于 navbar 红点提醒）
 */
export async function getPendingPriceApprovalsCount(): Promise<number> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return 0;
  const { count } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .gte('expires_at', new Date().toISOString());
  return count || 0;
}

/**
 * 列出待审批的价格审批（CEO 用）
 */
export async function listPendingPriceApprovals() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录', data: null };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可查看', data: null };

  const { data, error } = await (supabase.from('pre_order_price_approvals') as any)
    .select(`
      id, customer_name, po_number, form_snapshot, price_diffs, summary,
      status, created_at, expires_at, review_note, reviewed_at,
      requester:profiles!pre_order_price_approvals_requested_by_fkey(name, email)
    `)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return { error: error.message, data: null };
  return { data: data || [], error: null };
}

/**
 * 业务员检查自己最近的审批进度
 */
export async function getMyPriceApproval(approvalId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录', data: null };

  const { data, error } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id, status, review_note, reviewed_at, expires_at, requested_by')
    .eq('id', approvalId)
    .single();

  if (error || !data) return { error: '审批记录不存在', data: null };
  if ((data as any).requested_by !== user.id) {
    return { error: '只能查看自己的审批', data: null };
  }
  return { data, error: null };
}

/**
 * 校验某个审批是否有效（供 createOrder 调用）
 */
export async function validatePriceApproval(approvalId: string, requesterId: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  const supabase = await createClient();
  const { data } = await (supabase.from('pre_order_price_approvals') as any)
    .select('status, requested_by, expires_at')
    .eq('id', approvalId)
    .single();
  if (!data) return { valid: false, error: '审批记录不存在' };
  if ((data as any).requested_by !== requesterId) return { valid: false, error: '审批申请人与当前用户不符' };
  if ((data as any).status !== 'approved') {
    return { valid: false, error: `审批状态为「${(data as any).status}」，需 CEO 批准` };
  }
  const expiresAt = (data as any).expires_at;
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return { valid: false, error: '审批已过期（24 小时），请重新申请' };
  }
  return { valid: true };
}
