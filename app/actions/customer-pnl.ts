'use server';

import { createClient } from '@/lib/supabase/server';
import { computeCustomerPnl, type CustomerPnlData } from '@/lib/services/customer/customer-pnl.service';
import { hasRoleInGroup } from '@/lib/domain/roles';

// Re-export for consumers that import the type from this module
export type { CustomerPnlData as CustomerPnlSummary };

export async function getCustomerPnlSummary(
  customerName: string,
): Promise<{ data?: CustomerPnlData; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 价格红线：客户利润仅可见财务的角色可读
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  if (!hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS')) {
    return { error: '无权查看客户利润' };
  }

  return computeCustomerPnl(customerName, supabase);
}
