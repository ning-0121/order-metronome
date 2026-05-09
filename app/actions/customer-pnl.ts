'use server';

import { createClient } from '@/lib/supabase/server';
import { computeCustomerPnl, type CustomerPnlData } from '@/lib/services/customer/customer-pnl.service';

// Re-export for consumers that import the type from this module
export type { CustomerPnlData as CustomerPnlSummary };

export async function getCustomerPnlSummary(
  customerName: string,
): Promise<{ data?: CustomerPnlData; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  return computeCustomerPnl(customerName, supabase);
}
