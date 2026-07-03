import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole, getUserRoles } from '@/lib/utils/user-role';

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);

  // Admin → /ceo（决策视图）
  if (isAdmin) redirect('/ceo');

  // 按角色送到自己的工作台（2026-07-03:采购登录后落采购中心,不再停留在上次浏览页）
  const roles = await getUserRoles(supabase, user.id);
  if (roles.some(r => r === 'procurement' || r === 'procurement_manager')) redirect('/procurement');

  // 其他员工 → /dashboard（执行视图·我的工作台）
  redirect('/dashboard');
}
