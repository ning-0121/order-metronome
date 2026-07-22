'use server';

import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/utils/db-error';
import { isApprovalPending } from '@/lib/domain/types';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';

/**
 * 价格审批权限（基于角色，非邮箱白名单）：admin / 业务部经理
 * 2026-06 起从 getCurrentUserRole（邮箱白名单）切到 profiles.roles 角色判断。
 */
async function canApprovePrice(supabase: any, userId: string): Promise<boolean> {
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  return hasRoleInGroup(roles, 'CAN_APPROVE_PRICE');
}

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

  if (error) return { error: friendlyError(error) };

  // 推送到财务系统
  try {
    const { pushPriceApprovalToFinance } = await import('@/lib/integration/finance-sync');
    const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
    await pushPriceApprovalToFinance({
      id: (data as any).id,
      order_no: '',
      customer_name: payload.customer_name || '',
      po_number: payload.po_number || '',
      requested_by: user.id,
      requester_name: (profile as any)?.name || user.email?.split('@')[0] || '',
      price_diffs: payload.price_diffs,
      summary: payload.summary || '',
      form_snapshot: payload.form_snapshot,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),  // 2026-07-21:24h→7天(24h常来不及批)
      created_at: new Date().toISOString(),
    });
  } catch (e: any) { console.warn(`[price-approvals] 推送失败不阻断:`, e?.message); }

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

  if (!(await canApprovePrice(supabase, user.id))) return { error: '仅管理员/CEO 或业务部经理可审批价格' };

  const { data: row } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id, status, requested_by, customer_name, po_number')
    .eq('id', approvalId)
    .single();
  if (!row) return { error: '审批记录不存在' };
  if (!isApprovalPending(row.status)) return { error: `该申请已是「${row.status}」状态，无法重复审批` };
  // P1 修:不能审批自己提交的价格申请(admin 例外)
  if (row.requested_by === user.id) {
    const { data: pProf } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
    const pRoles: string[] = (pProf as any)?.roles?.length > 0 ? (pProf as any).roles : [(pProf as any)?.role].filter(Boolean);
    if (!pRoles.includes('admin')) return { error: '不能审批自己提交的价格申请' };
  }

  const { error } = await (supabase.from('pre_order_price_approvals') as any)
    .update({
      status: decision,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note || null,
    })
    .eq('id', approvalId);

  if (error) return { error: friendlyError(error) };

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
  } catch (e: any) { console.warn(`[price-approvals] price_approval 应用内通知发送:`, e?.message); }

  // 企业微信推送
  try {
    const { pushToUsers } = await import('@/lib/utils/wechat-push');
    await pushToUsers(supabase, [requesterId], title, message);
  } catch (e: any) { console.warn(`[price-approvals] price_approval 企微推送:`, e?.message); }

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
  if (!(await canApprovePrice(supabase, user.id))) return 0;
  // 2026-07-21:过期的待审批也算待办(仍需 admin 处理,不该从计数里消失)。
  const { count } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  return count || 0;
}

/**
 * 列出待审批的价格审批（CEO 用）
 */
export async function listPendingPriceApprovals() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录', data: null };

  if (!(await canApprovePrice(supabase, user.id))) return { error: '仅管理员或业务部经理可查看', data: null };

  const { data, error } = await (supabase.from('pre_order_price_approvals') as any)
    .select('id, customer_name, po_number, form_snapshot, price_diffs, summary, status, created_at, expires_at, review_note, reviewed_at, requested_by')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return { error: error.message, data: null };

  // 查询申请人姓名（两步查询，避免外键关联报错）
  const requesterIds = [...new Set((data || []).map((d: any) => d.requested_by).filter(Boolean))];
  let requesterMap: Record<string, { name: string; email: string }> = {};
  if (requesterIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email')
      .in('user_id', requesterIds);
    if (profiles) {
      requesterMap = (profiles as any[]).reduce((m, p) => {
        m[p.user_id] = { name: p.name, email: p.email };
        return m;
      }, {} as Record<string, any>);
    }
  }
  const enriched = (data || []).map((d: any) => ({
    ...d,
    requester: requesterMap[d.requested_by] || null,
  }));

  return { data: enriched, error: null };
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
  // 2026-07-21:已批准 = 已做决策,建单不再卡原始申请窗口的过期(过期只针对"待审批"未处理时限,
  //   批准后即有效)。此前 admin 批了过期申请、业务员建单仍被"审批已过期"挡,导致订单建不出来。
  return { valid: true };
}
