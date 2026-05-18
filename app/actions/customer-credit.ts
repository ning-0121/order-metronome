'use server';

/**
 * 查询客户的信用分级（用于新订单创建时显示风险 banner）
 *
 * 读 customer_rhythm（SoT），派生计算 credit_tier。不写库。
 */

import { createClient } from '@/lib/supabase/server';
import { computeCreditTier, type CreditTierResult } from '@/lib/domain/customerCredit';

export interface CustomerCreditInfo extends CreditTierResult {
  customerName: string;
  totalOrderCount: number;
  overduePayments: number;
  riskScore: number;
}

export async function getCustomerCredit(customerName: string): Promise<{
  data?: CustomerCreditInfo;
  error?: string;
}> {
  if (!customerName?.trim()) {
    return { error: '客户名为空' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 读 customer_rhythm 派生数据
  const { data: rhythm } = await (supabase.from('customer_rhythm') as any)
    .select('total_order_count, overdue_payments, risk_score')
    .eq('customer_name', customerName.trim())
    .maybeSingle();

  // 如果没有 rhythm 行（首次接触客户），fallback 查 orders 表
  let totalOrderCount = (rhythm as any)?.total_order_count ?? 0;
  if (!rhythm) {
    const { count } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .eq('customer_name', customerName.trim());
    totalOrderCount = count ?? 0;
  }

  const overduePayments = (rhythm as any)?.overdue_payments ?? 0;
  const riskScore = (rhythm as any)?.risk_score ?? 0;

  const tier = computeCreditTier({
    totalOrderCount,
    overduePayments,
    riskScore,
  });

  return {
    data: {
      ...tier,
      customerName: customerName.trim(),
      totalOrderCount,
      overduePayments,
      riskScore,
    },
  };
}
