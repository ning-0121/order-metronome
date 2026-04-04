import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { FactoryManager } from '@/components/FactoryManager';

export default async function FactoriesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin, role } = await getCurrentUserRole(supabase);
  // 管理员、业务、跟单、生产主管、采购可管理工厂
  const userRoles = await supabase.from('profiles').select('roles').eq('user_id', user.id).single();
  const roles: string[] = (userRoles.data as any)?.roles || [role].filter(Boolean);
  const canEdit = isAdmin || roles.some(r => ['sales', 'merchandiser', 'production_manager', 'procurement'].includes(r));

  const { data: factories } = await (supabase.from('factories') as any)
    .select('*')
    .is('deleted_at', null)
    .order('factory_name', { ascending: true });

  // 每个工厂的订单统计
  const { data: orders } = await (supabase.from('orders') as any)
    .select('factory_name, lifecycle_status');
  const statsMap: Record<string, { active: number; completed: number }> = {};
  for (const o of orders || []) {
    if (!o.factory_name) continue;
    if (!statsMap[o.factory_name]) statsMap[o.factory_name] = { active: 0, completed: 0 };
    const ls = o.lifecycle_status || '';
    if (['已完成', 'completed', '已复盘'].includes(ls)) statsMap[o.factory_name].completed++;
    else if (!['已取消', 'cancelled'].includes(ls)) statsMap[o.factory_name].active++;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🏭 工厂管理</h1>
        <p className="mt-1 text-sm text-gray-500">共 {(factories || []).length} 家合作工厂</p>
      </div>
      <FactoryManager factories={factories || []} statsMap={statsMap} canEdit={canEdit} />
    </div>
  );
}
