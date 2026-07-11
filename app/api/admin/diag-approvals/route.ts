import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

/**
 * 临时诊断(排查「高洁收不到延期/改单审批提示」)—— 用完删。
 * admin 门禁 + service-role 读全量,回答三件事:
 *   1. 高洁/经理们的 profiles.role/roles 到底是什么(角色有没有真存进去)
 *   2. 最近的站内通知是发给谁的(审批通知有没有被创建、有没有落到经理头上)
 *   3. 最近的待审批延期/改单(有没有 pending 的、审批链长啥样)
 * GET /api/admin/diag-approvals
 */
export async function GET() {
  const userClient = await createClient();
  const { isAdmin } = await getCurrentUserRole(userClient);
  if (!isAdmin) return NextResponse.json({ error: '仅管理员可访问' }, { status: 403 });

  const svc = createServiceRoleClient();

  // 1) 所有 profiles 的角色(重点看高洁 + 谁是 order_manager/sales_manager)
  const { data: profiles } = await (svc.from('profiles') as any)
    .select('user_id, name, email, role, roles, active');
  const managers = (profiles || []).filter((p: any) => {
    const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
    return rs.some((r) => ['admin', 'order_manager', 'sales_manager'].includes(r));
  }).map((p: any) => ({ name: p.name, email: p.email, role: p.role, roles: p.roles, active: p.active, user_id: p.user_id }));
  const gaojie = (profiles || []).filter((p: any) => String(p.name || '').includes('高洁'))
    .map((p: any) => ({ name: p.name, email: p.email, role: p.role, roles: p.roles, active: p.active, user_id: p.user_id }));

  // 2) 最近 20 条通知(看有没有 deferral_approval / amendment_approval / delay_request,发给谁)
  const { data: notifs } = await (svc.from('notifications') as any)
    .select('user_id, type, title, status, created_at')
    .in('type', ['deferral_approval', 'amendment_approval', 'delay_request'])
    .order('created_at', { ascending: false }).limit(20);
  const nameByUser = new Map<string, string>((profiles || []).map((p: any) => [p.user_id, p.name]));
  const recentApprovalNotifs = (notifs || []).map((n: any) => ({
    to: nameByUser.get(n.user_id) || n.user_id, type: n.type, title: n.title, status: n.status, at: n.created_at,
  }));

  // 3) 最近待审批的延期 + 改单
  const { data: delays } = await (svc.from('delay_requests') as any)
    .select('id, order_id, status, approval_chain, current_step, requested_by, created_at')
    .eq('status', 'pending').order('created_at', { ascending: false }).limit(10);
  const { data: amendments } = await (svc.from('order_amendments') as any)
    .select('id, order_id, status, requested_by, created_at')
    .eq('status', 'pending').order('created_at', { ascending: false }).limit(10);

  return NextResponse.json({
    高洁: gaojie.length ? gaojie : '❌ profiles 里没有名字含「高洁」的用户',
    管理审批人们_admin_order_manager_sales_manager: managers,
    最近审批通知发给谁: recentApprovalNotifs.length ? recentApprovalNotifs : '❌ 最近没有任何 deferral_approval/amendment_approval/delay_request 通知被创建',
    待审批延期: (delays || []).map((d: any) => ({ ...d, requested_by_name: nameByUser.get(d.requested_by) || d.requested_by })),
    待审批改单: (amendments || []).map((a: any) => ({ ...a, requested_by_name: nameByUser.get(a.requested_by) || a.requested_by })),
  }, { status: 200 });
}
