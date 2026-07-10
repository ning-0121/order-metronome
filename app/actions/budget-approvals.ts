'use server';

/**
 * 超预算提交采购 —— 两级审批(2026-07-06 用户拍板)。
 * 口径:BOM 单耗只要超报价基线 → 拦,报业务执行经理批;超过 5% → 业务经理 + 财务 都要批。批过才能提交采购。
 * 写入全走 service-role(调用方已做业务角色鉴权;审批 action 内单独做经理/财务角色门禁)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const MGR_ROLES = ['order_manager', 'sales_manager', 'admin'];   // 业务执行经理
const FIN_ROLES = ['finance', 'admin'];                          // 财务

export interface OverLine { material: string; bom_cons: number; base_cons: number; over_pct: number; }

async function ctx() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null as any, roles: [] as string[] };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p as any)?.roles?.length ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  return { user, roles };
}

/**
 * 提交采购时调用(传 service-role 客户端 svc)。
 * 返回 { ok:true } = 已批/无需批,放行;{ ok:false, message } = 已挂起审批,拦下。
 */
export async function ensureBudgetApproval(
  svc: any, orderId: string, requestedBy: string, overLines: OverLine[],
): Promise<{ ok: boolean; message?: string }> {
  if (!overLines || overLines.length === 0) return { ok: true };
  const maxOver = Math.max(...overLines.map((l) => l.over_pct));
  const needsFinance = maxOver > 5;

  try {
    const { data: latest, error: selErr } = await svc.from('procurement_budget_approvals')
      .select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (selErr && /does not exist|relation/i.test(selErr.message || '')) {
      return { ok: false, message: '超预算,审批数据表未建 —— 请先在 Supabase 执行 20260706_budget_approvals.sql 后再提交。' };
    }

    // 已批且覆盖当前超标 → 放行
    if (latest && latest.status === 'approved'
        && Number(latest.max_over_pct) >= maxOver
        && (!needsFinance || latest.fin_status === 'approved')) {
      return { ok: true };
    }

    const row: Record<string, any> = {
      order_id: orderId, requested_by: requestedBy, requested_at: new Date().toISOString(),
      over_lines: overLines, max_over_pct: maxOver, needs_finance: needsFinance,
      mgr_status: 'pending', mgr_by: null, mgr_at: null, mgr_note: null,
      fin_status: needsFinance ? 'pending' : 'not_required', fin_by: null, fin_at: null, fin_note: null,
      status: 'pending', updated_at: new Date().toISOString(),
    };
    let approvalId: string | undefined;
    if (latest && latest.status === 'pending') {
      await svc.from('procurement_budget_approvals').update(row).eq('id', latest.id);
      approvalId = latest.id;
    } else {
      const { data: ins } = await svc.from('procurement_budget_approvals').insert(row).select('id').single();
      approvalId = (ins as any)?.id;
    }
    await notifyApprovers(svc, orderId, needsFinance, maxOver).catch(() => {});
    const who = needsFinance ? '业务执行经理 + 财务' : '业务执行经理';
    return { ok: false, message: `原辅料单耗超报价基线(最高 +${Math.round(maxOver)}%),不能直接提交采购。已报「${who}」审批,批准后再来提交。` };
  } catch (e: any) {
    // 审批链路异常 → 保守拦下(绝不放行超预算)
    return { ok: false, message: `超预算,审批处理异常已拦下(${e?.message || ''})。请稍后重试或联系管理员。` };
  }
}

async function notifyApprovers(svc: any, orderId: string, needsFinance: boolean, maxOver: number) {
  const targetRoles = needsFinance ? ['order_manager', 'sales_manager', 'finance'] : ['order_manager', 'sales_manager'];
  const { data: order } = await svc.from('orders').select('order_no, internal_order_no, customer_name').eq('id', orderId).maybeSingle();
  const { data: profs } = await svc.from('profiles').select('user_id, role, roles');
  const recipients = [...new Set((profs || []).filter((p: any) => {
    const rs = p.roles?.length ? p.roles : [p.role].filter(Boolean);
    return rs.some((r: string) => targetRoles.includes(r));
  }).map((p: any) => p.user_id))];
  if (!recipients.length) return;
  const rows = recipients.map((uid) => ({
    user_id: uid, type: 'budget_approval',
    title: `🟠 超预算待审批 — ${(order as any)?.internal_order_no || (order as any)?.order_no || ''}`,
    message: `${(order as any)?.customer_name || ''} 原辅料单耗超报价基线 +${Math.round(maxOver)}%,需审批才能提交采购。`,
    related_order_id: orderId, is_read: false,
  }));
  await svc.from('notifications').insert(rows);
}

/** 审批(业务经理批 mgr;财务批 fin)。 */
export async function decideBudgetApproval(id: string, decision: 'approved' | 'rejected', note?: string): Promise<{ ok?: boolean; status?: string; error?: string }> {
  const { user, roles } = await ctx();
  if (!user) return { error: '请先登录' };
  const isMgr = roles.some((r) => MGR_ROLES.includes(r));
  const isFin = roles.some((r) => FIN_ROLES.includes(r));
  if (!isMgr && !isFin) return { error: '仅业务执行经理/财务/管理员可审批超预算' };

  const svc = createServiceRoleClient();
  const { data: a } = await (svc.from('procurement_budget_approvals') as any).select('*').eq('id', id).maybeSingle();
  if (!a) return { error: '审批单不存在' };
  if (a.status !== 'pending') return { error: '该审批已结束' };
  // P1 修:不能审批自己提交的申请(admin 例外)——小组织里业务经理既提又批的自批洞
  if (a.requested_by === user.id && !roles.includes('admin')) return { error: '不能审批自己提交的超预算申请' };

  const now = new Date().toISOString();
  const upd: Record<string, any> = { updated_at: now };
  if (isMgr && a.mgr_status === 'pending') {
    upd.mgr_status = decision; upd.mgr_by = user.id; upd.mgr_at = now; upd.mgr_note = note || null;
  } else if (isFin && a.needs_finance && a.fin_status === 'pending') {
    upd.fin_status = decision; upd.fin_by = user.id; upd.fin_at = now; upd.fin_note = note || null;
  } else {
    return { error: '当前没有你可审的环节(或该环节已审)' };
  }
  const mgrS = upd.mgr_status ?? a.mgr_status;
  const finS = upd.fin_status ?? a.fin_status;
  if (mgrS === 'rejected' || finS === 'rejected') upd.status = 'rejected';
  else if (mgrS === 'approved' && (a.needs_finance ? finS === 'approved' : true)) upd.status = 'approved';
  else upd.status = 'pending';

  const { error: uErr } = await (svc.from('procurement_budget_approvals') as any).update(upd).eq('id', id);
  if (uErr) return { error: uErr.message };

  try {
    const { data: order } = await (svc.from('orders') as any).select('order_no, internal_order_no').eq('id', a.order_id).maybeSingle();
    const tag = (order as any)?.internal_order_no || (order as any)?.order_no || '';
    await (svc.from('notifications') as any).insert({
      user_id: a.requested_by, type: 'budget_approval',
      title: upd.status === 'approved' ? '✅ 超预算已批准,可提交采购' : upd.status === 'rejected' ? '❌ 超预算被驳回' : '超预算审批进展',
      message: `${tag} 超预算审批:${mgrS === 'approved' ? '经理已批' : mgrS === 'rejected' ? '经理驳回' : '待经理'}${a.needs_finance ? (finS === 'approved' ? ' · 财务已批' : finS === 'rejected' ? ' · 财务驳回' : ' · 待财务') : ''}${note ? '(' + note + ')' : ''}`,
      related_order_id: a.order_id, is_read: false,
    });
  } catch { /* 通知失败不阻断 */ }

  revalidatePath(`/orders/${a.order_id}`);
  return { ok: true, status: upd.status };
}

/** 读某单最新超预算审批(订单详情面板展示 + 审批权判定)。 */
export async function getOrderBudgetApproval(orderId: string): Promise<{ data?: any; canMgr?: boolean; canFin?: boolean; error?: string }> {
  const { user, roles } = await ctx();
  if (!user) return { error: '请先登录' };
  const svc = createServiceRoleClient();
  const { data } = await (svc.from('procurement_budget_approvals') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return { data: data || null, canMgr: roles.some((r) => MGR_ROLES.includes(r)), canFin: roles.some((r) => FIN_ROLES.includes(r)) };
}
