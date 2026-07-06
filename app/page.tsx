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
  // H4(用户 2026-07-06 拍板):纯财务(仅 finance 角色)登录后自动 SSO 进财务系统;
  // admin 或兼职其它角色的不跳(用导航栏「进入财务系统」按钮)。只在落地页 / 跳,
  // 直达具体节拍器页(如某订单)不被劫持,财务人仍可点链接看单据。
  if (roles.length > 0 && roles.every(r => r === 'finance')) redirect('/api/finance-sso');
  if (roles.some(r => r === 'procurement' || r === 'procurement_manager')) redirect('/procurement');

  // 其他员工 → /dashboard（执行视图·我的工作台）
  redirect('/dashboard');
}
