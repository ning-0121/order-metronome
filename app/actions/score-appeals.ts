'use server';

/**
 * 统一评分申诉(2026-07-25 CEO 批的评分制度 Q3)。
 * 三类:po_overdue(PO逾期罚款)/ node_overdue(节点逾期扣分)/ quality(质量扣分)。
 * 证据必传 → 域路由审批(业务经理/生产主管/采购经理;PO 另需财务会签;老板可 override)→
 * 通过后评分函数据"已批准申诉"豁免对应扣分。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { getUserRoles } from '@/lib/utils/user-role';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';
import { notifyUsersByRole } from '@/lib/utils/notifications';
import {
  routeReviewerRole, resolveAppeal, withinAppealWindow, APPEAL_WINDOW_DAYS,
  type AppealType,
} from '@/lib/domain/scoreAppeal';

const MISSING = /score_appeals|relation .* does not exist|does not exist|schema cache|could not find/i;
const MIGRATE_HINT = '评分申诉表未建,请先执行 supabase/migrations/20260725_score_appeals.sql';
const VALID_TYPES: AppealType[] = ['po_overdue', 'node_overdue', 'quality'];
const VALID_CATS = ['customer', 'supplier', 'force_majeure', 'system', 'other'];

export async function listScoreAppeals(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };
  const { data, error } = await (supabase.from('score_appeals') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false });
  if (error) return MISSING.test(error.message || '') ? { data: [] } : { error: error.message };
  // 补提交人/审批人名
  const ids = [...new Set(((data || []) as any[]).flatMap((a) => [a.submitted_by, a.reviewed_by]).filter(Boolean))];
  let nameMap: Record<string, string> = {};
  if (ids.length) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', ids);
    nameMap = (profs || []).reduce((m: any, p: any) => { m[p.user_id] = p.name; return m; }, {});
  }
  return { data: ((data || []) as any[]).map((a) => ({ ...a, submitter_name: nameMap[a.submitted_by] || null, reviewer_name: nameMap[a.reviewed_by] || null })) };
}

export async function submitScoreAppeal(orderId: string, input: {
  appeal_type: AppealType; milestone_id?: string | null; target_key?: string | null;
  reason_category: string; reason: string; evidence_urls: string[];
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权对此订单申诉' };
  if (!VALID_TYPES.includes(input.appeal_type)) return { error: '申诉类型不合法' };
  if (!VALID_CATS.includes(input.reason_category)) return { error: '请选择申诉原因类别' };
  if (!input.reason?.trim()) return { error: '请填写申诉说明' };
  // 证据必传(CEO 尺度:无证据不受理)
  const evidence = (input.evidence_urls || []).filter((u) => typeof u === 'string' && u.trim());
  if (evidence.length === 0) return { error: '必须上传证据(邮件/供应商函/验货报告等),无证据不受理' };

  // 节点归属 → 一审角色 + 时限校验(节点逾期/完成后 N 天内)
  let ownerRole: string | null = null;
  let refDate: string | null = null;
  if (input.milestone_id) {
    const { data: ms } = await (supabase.from('milestones') as any)
      .select('owner_role, due_at, actual_at').eq('id', input.milestone_id).eq('order_id', orderId).maybeSingle();
    if (!ms) return { error: '关联节点不存在' };
    ownerRole = (ms as any).owner_role || null;
    refDate = (ms as any).actual_at || (ms as any).due_at || null;
  }
  if (input.appeal_type !== 'po_overdue' && refDate && !withinAppealWindow(refDate, Date.now())) {
    return { error: `已过申诉时限(节点逾期/完成后 ${APPEAL_WINDOW_DAYS} 天内可申诉)` };
  }
  const reviewerRole = routeReviewerRole(input.appeal_type, ownerRole);

  const { error } = await (supabase.from('score_appeals') as any).insert({
    order_id: orderId, appeal_type: input.appeal_type,
    milestone_id: input.milestone_id || null, target_key: input.target_key || null,
    reason_category: input.reason_category, reason: input.reason.trim(),
    evidence_urls: evidence, status: 'pending', reviewer_role: reviewerRole, submitted_by: user.id,
  });
  if (error) return MISSING.test(error.message || '') ? { error: MIGRATE_HINT } : { error: friendlyError(error) };

  // 通知审批人(域经理;PO 另通知财务)。notifyUsersByRole 内部走 service-role。
  try {
    const roles = input.appeal_type === 'po_overdue' ? [reviewerRole, 'finance', 'admin'] : [reviewerRole, 'admin'];
    await notifyUsersByRole(supabase as any, roles, {
      type: 'score_appeal', title: '📝 评分申诉待审',
      message: `一笔${input.appeal_type === 'po_overdue' ? 'PO逾期' : input.appeal_type === 'quality' ? '质量扣分' : '节点逾期'}申诉待你审批。原因:${input.reason.trim().slice(0, 40)}`,
      relatedOrderId: orderId,
    });
  } catch { /* 通知失败不阻断 */ }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 审批一步:按用户角色写对应决定(域经理→reviewer_decision;财务→finance_decision;老板→admin_override),汇总裁决。 */
export async function decideScoreAppeal(appealId: string, decision: 'approved' | 'rejected', note?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await getUserRoles(supabase, user.id);
  const isAdmin = roles.includes('admin');

  const { data: a } = await (supabase.from('score_appeals') as any).select('*').eq('id', appealId).maybeSingle();
  if (!a) return { error: '申诉不存在' };
  if ((a as any).status !== 'pending') return { error: '该申诉已有结果' };

  const patch: Record<string, any> = { reviewed_by: user.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (note?.trim()) patch.decision_note = note.trim();
  // 谁能审:老板(override)/ 该域经理(reviewer_decision)/ 财务(仅 po_overdue 的 finance_decision)
  if (isAdmin) patch.admin_override = decision;
  else if (roles.includes((a as any).reviewer_role)) patch.reviewer_decision = decision;
  else if ((a as any).appeal_type === 'po_overdue' && roles.includes('finance')) patch.finance_decision = decision;
  else return { error: '你不是该申诉的审批人' };

  const merged = { ...(a as any), ...patch };
  const status = resolveAppeal(merged);
  patch.status = status;

  const { error } = await (supabase.from('score_appeals') as any).update(patch).eq('id', appealId).eq('status', 'pending');
  if (error) return MISSING.test(error.message || '') ? { error: MIGRATE_HINT } : { error: friendlyError(error) };

  // 通过 + 是 PO逾期 → 桥接现有免罚标志(评分 PO 罚款逻辑不变)
  if (status === 'approved' && (a as any).appeal_type === 'po_overdue') {
    try { await (supabase.from('orders') as any).update({ po_penalty_waived: true, updated_at: new Date().toISOString() }).eq('id', (a as any).order_id); } catch { /* 不阻断 */ }
  }
  // 通过/驳回 → 重算评分(node/quality 豁免直接体现)
  if (status !== 'pending') {
    try { const { calculateOrderScore } = await import('./commissions'); await calculateOrderScore((a as any).order_id); } catch { /* 不阻断 */ }
  }
  revalidatePath(`/orders/${(a as any).order_id}`);
  return { ok: true, status };
}
