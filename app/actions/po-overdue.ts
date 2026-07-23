'use server';

/**
 * PO 逾期上传·免罚审批(2026-07-23 · 二期)
 * 业务申请免罚 → 业务执行经理(order_manager)+ 财务(finance)两方会签通过免罚;
 * 老板(admin)可单方 override(单独批准或驳回,优先于两方)。
 * 通过 → orders.po_penalty_waived=true(撤销罚款/考核);驳回 → 罚款保留。
 */

import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/utils/db-error';
import { revalidatePath } from 'next/cache';

export interface PoWaiver {
  id: string;
  order_id: string;
  requested_by: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  order_manager_decision: 'approved' | 'rejected' | null;
  finance_decision: 'approved' | 'rejected' | null;
  admin_override: 'approved' | 'rejected' | null;
  created_at: string;
  requester_name?: string | null;
}

async function getRoles(supabase: any, userId: string): Promise<string[]> {
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  return (p?.roles?.length > 0 ? p.roles : [p?.role].filter(Boolean)) as string[];
}

/** 该订单最新的免罚申请(给订单页横幅用) */
export async function getPoWaiver(orderId: string): Promise<{ data?: PoWaiver | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data } = await (supabase.from('po_overdue_waivers') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return { data: null };
  let requester_name: string | null = null;
  if (data.requested_by) {
    const { data: pr } = await (supabase.from('profiles') as any).select('name').eq('user_id', data.requested_by).maybeSingle();
    requester_name = (pr as any)?.name || null;
  }
  return { data: { ...data, requester_name } };
}

/** 业务申请免罚 */
export async function requestPoOverdueWaiver(orderId: string, reason: string): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!reason?.trim()) return { error: '请填写申请免罚的理由' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, po_number, po_overdue, po_penalty_waived, po_overdue_days').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  if (!order.po_overdue) return { error: '该订单未逾期,无需申请免罚' };
  if (order.po_penalty_waived) return { error: '该订单罚款已免除' };
  // 已有 pending 申请则不重复建
  const { data: existing } = await (supabase.from('po_overdue_waivers') as any)
    .select('id').eq('order_id', orderId).eq('status', 'pending').maybeSingle();
  if (existing) return { error: '已有免罚申请在审批中,请勿重复提交' };

  const { data, error } = await (supabase.from('po_overdue_waivers') as any)
    .insert({ order_id: orderId, requested_by: user.id, reason: reason.trim(), status: 'pending' })
    .select('id').single();
  if (error) return { error: friendlyError(error) };

  // 通知审批人:业务执行经理 / 财务 / 老板
  try {
    const { data: pr } = await (supabase.from('profiles') as any).select('name').eq('user_id', user.id).maybeSingle();
    const cname = (pr as any)?.name || user.email?.split('@')[0] || '业务';
    const { data: recips } = await (supabase.from('profiles') as any)
      .select('user_id').or('role.in.(order_manager,finance,admin),roles.cs.{order_manager},roles.cs.{finance},roles.cs.{admin}');
    const ids = [...new Set((recips || []).map((r: any) => r.user_id).filter(Boolean))] as string[];
    const label = order.internal_order_no || order.order_no;
    const title = `📝 PO 逾期免罚申请待审 — ${label}`;
    const message = `${cname} 为 ${order.customer_name}·PO ${order.po_number || '—'}(逾期${order.po_overdue_days}天)申请免罚。理由:${reason.trim()}。需业务执行经理+财务两方通过(或老板批准)。到订单页审批。`;
    if (ids.length) {
      await (supabase.from('notifications') as any).insert(ids.map((uid) => ({ user_id: uid, type: 'po_waiver_request', title, message, related_order_id: orderId, status: 'unread' })));
      try { const { pushToUsers } = await import('@/lib/utils/wechat-push'); await pushToUsers(supabase, ids, title, message); } catch { /* 企微失败不阻断 */ }
    }
  } catch (e: any) { console.warn('[po-overdue] 申请通知失败不阻断:', e?.message); }

  revalidatePath(`/orders/${orderId}`);
  return { id: (data as any).id };
}

function resolve(w: any): { status: 'pending' | 'approved' | 'rejected'; waived: boolean } {
  if (w.admin_override === 'approved') return { status: 'approved', waived: true };
  if (w.admin_override === 'rejected') return { status: 'rejected', waived: false };
  if (w.order_manager_decision === 'rejected' || w.finance_decision === 'rejected') return { status: 'rejected', waived: false };
  if (w.order_manager_decision === 'approved' && w.finance_decision === 'approved') return { status: 'approved', waived: true };
  return { status: 'pending', waived: false };
}

/** 审批人决策(业务执行经理/财务/老板) */
export async function reviewPoOverdueWaiver(waiverId: string, decision: 'approved' | 'rejected', note?: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getRoles(supabase, user.id);

  const { data: w } = await (supabase.from('po_overdue_waivers') as any).select('*').eq('id', waiverId).maybeSingle();
  if (!w) return { error: '免罚申请不存在' };
  if (w.status !== 'pending') return { error: `该申请已是「${w.status}」,无法重复审批` };

  const now = new Date().toISOString();
  const patch: Record<string, any> = {};
  // 老板 override 优先;否则按业务执行经理/财务各填各的槽
  if (roles.includes('admin')) { patch.admin_override = decision; patch.admin_by = user.id; patch.admin_at = now; }
  else if (roles.includes('order_manager')) { patch.order_manager_decision = decision; patch.order_manager_by = user.id; patch.order_manager_at = now; }
  else if (roles.includes('finance')) { patch.finance_decision = decision; patch.finance_by = user.id; patch.finance_at = now; }
  else return { error: '仅业务执行经理 / 财务 / 老板可审批免罚' };

  const merged = { ...w, ...patch };
  const r = resolve(merged);
  if (r.status !== 'pending') { patch.status = r.status; patch.resolved_at = now; }

  const { error } = await (supabase.from('po_overdue_waivers') as any).update(patch).eq('id', waiverId);
  if (error) return { error: friendlyError(error) };

  // 终态 → 更新订单罚款状态
  if (r.status === 'approved') {
    await (supabase.from('orders') as any).update({ po_penalty_waived: true }).eq('id', w.order_id);
  }

  // 通知申请人 + 三方
  try {
    const { data: order } = await (supabase.from('orders') as any).select('order_no, internal_order_no').eq('id', w.order_id).maybeSingle();
    const label = (order as any)?.internal_order_no || (order as any)?.order_no || w.order_id;
    const who = roles.includes('admin') ? '老板' : roles.includes('order_manager') ? '业务执行经理' : '财务';
    const recipients = new Set<string>([w.requested_by].filter(Boolean) as string[]);
    let title: string, message: string;
    if (r.status === 'approved') { title = `✅ PO 逾期免罚已批准 — ${label}`; message = `免罚申请已通过,罚款¥已撤销、不计逾期考核。${note ? '备注:' + note : ''}`; }
    else if (r.status === 'rejected') { title = `❌ PO 逾期免罚被驳回 — ${label}`; message = `${who}驳回了免罚申请,罚款保留。${note ? '原因:' + note : ''}`; }
    else { title = `📝 PO 免罚:${who}已${decision === 'approved' ? '通过' : '驳回'} — ${label}`; message = `${who}已${decision === 'approved' ? '通过' : '驳回'},等另一方会签。${note ? '备注:' + note : ''}`; }
    if (recipients.size) {
      await (supabase.from('notifications') as any).insert([...recipients].map((uid) => ({ user_id: uid, type: 'po_waiver_result', title, message, related_order_id: w.order_id, status: 'unread' })));
      try { const { pushToUsers } = await import('@/lib/utils/wechat-push'); await pushToUsers(supabase, [...recipients], title, message); } catch { /* 企微失败不阻断 */ }
    }
  } catch (e: any) { console.warn('[po-overdue] 审批通知失败不阻断:', e?.message); }

  revalidatePath(`/orders/${w.order_id}`);
  return {};
}
