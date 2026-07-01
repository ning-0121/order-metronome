import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { getInventoryBalance, listOrdersForIssue } from '@/app/actions/inventory';
import { InventoryClient } from './InventoryClient';

// 库存余额 + 领料/退料（W1）。收货自动入库;领料/退料由仓库/生产录。
export default async function InventoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canIssue = hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL');

  const { data: balance, error } = await getInventoryBalance();
  const orders = canIssue ? ((await listOrdersForIssue()).data || []) : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">库存余额</h1>
      <p className="text-sm text-gray-500 mb-6">收货自动入库(增量) · 领料/退料随消耗增减 · 负库存(先领后入)红字提示。</p>
      {error ? (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">{error}</div>
      ) : (
        <InventoryClient balance={balance || []} orders={orders} canIssue={canIssue} />
      )}
    </div>
  );
}
