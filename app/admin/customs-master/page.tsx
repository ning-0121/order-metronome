import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { CustomsMasterClient } from './CustomsMasterClient';

export const dynamic = 'force-dynamic';

/**
 * 报关主数据(2026-07-28 CEO 报关4件套①②③):HS/报关品名目录 + 公司级默认值 + 客户报关抬头。
 * 品类少 → 目录建几十行全覆盖;出运单证生成时自动带出,业务只补缺。管理/业务可维护。
 */
export default async function CustomsMasterPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <div className="p-8 text-center text-gray-400">请先登录</div>;
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const canEdit = roles.includes('admin') || hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS') || roles.some((r) => ['merchandiser', 'order_manager'].includes(r));
  if (!canEdit) return <div className="p-8 text-center text-red-500">仅管理/财务/业务可维护报关主数据</div>;

  const svc = createServiceRoleClient();
  const [{ data: catalog }, { data: defRow }, { data: customers }] = await Promise.all([
    (svc.from('customs_hs_catalog') as any).select('*').order('sort').order('created_at'),
    (svc.from('customs_defaults') as any).select('data').eq('id', 1).maybeSingle(),
    (svc.from('customers') as any).select('id, customer_name, consignee_name_en, customs_address, tax_no').order('customer_name'),
  ]);

  return <CustomsMasterClient catalog={catalog || []} defaults={(defRow as any)?.data || {}} customers={customers || []} />;
}
