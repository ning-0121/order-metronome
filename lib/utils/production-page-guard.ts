/**
 * 生产系统页面级门禁(2026-07-05)。
 * 生产中心只放 生产/生产经理/理单/管理员;其余角色回自己工作台。
 * action 层的读权限单独校验(见 getProductionCenter)。
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function requireProductionPage(extraRoles: string[] = []): Promise<{ userId: string; roles: string[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user!.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const allowed = ['admin', 'production', 'production_manager', 'merchandiser', 'order_manager', 'qc', 'quality', ...extraRoles];
  if (!roles.some((r) => allowed.includes(r))) redirect('/dashboard');
  return { userId: user!.id, roles };
}
