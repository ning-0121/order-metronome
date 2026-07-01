import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { listSuppliers } from '@/app/actions/suppliers';
import { SuppliersClient } from './SuppliersClient';

export default async function SuppliersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  const { data: suppliers, error } = await listSuppliers();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">供应商主数据</h1>
      <p className="text-sm text-gray-500 mb-6">业务填基础信息 · 财务填付款条款。（原辅料供应商，独立于生产工厂）</p>
      <SuppliersClient
        suppliers={(suppliers || []) as any[]}
        canBasic={hasRoleInGroup(roles, 'CAN_EDIT_SUPPLIER_BASIC')}
        canFinance={hasRoleInGroup(roles, 'CAN_EDIT_SUPPLIER_FINANCE')}
        error={error}
      />
    </div>
  );
}
