/**
 * 采购系统页面级门禁(2026-07-03 用户拍板:业务员不能进采购系统,防误改)。
 * server component 页面顶部调用;非采购角色直接送回自己的工作台。
 * action 层的读权限不动(业务在订单详情看「采购进度」仍可)。
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function requireProcurementPage(extraRoles: string[] = []): Promise<{ userId: string; roles: string[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user!.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const allowed = ['admin', 'procurement', 'procurement_manager', ...extraRoles];
  if (!roles.some(r => allowed.includes(r))) redirect('/dashboard');
  return { userId: user!.id, roles };
}

/** 该用户是否"纯采购"(只有采购类角色,无其他身份)——用于订单详情自动改道核料页 */
export function isProcurementOnly(roles: string[]): boolean {
  const rs = (roles || []).filter(Boolean);
  return rs.length > 0 && rs.every(r => ['procurement', 'procurement_manager'].includes(r));
}
