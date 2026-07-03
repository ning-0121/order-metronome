/**
 * 底价补取(service-role)—— 配合 20260704_pli_floor_column_revoke.sql。
 *
 * procurement_line_items 的价列(unit_price/ordered_amount/difference_amount)已对
 * authenticated 撤销列级 SELECT,用户会话读不到。凡"基础读走用户会话(RLS 管订单
 * 范围)+ 仅对 floor 角色补价"的入口,基础读完拿到 id 后,用本函数经 service-role
 * 把价列补回,再合并。**调用前必须已确认调用者是 CAN_SEE_PROCUREMENT_FLOOR。**
 */

import { createServiceRoleClient } from '@/lib/supabase/server';

export interface LineCost {
  unit_price: number | null;
  ordered_amount: number | null;
  difference_amount: number | null;
}

/** 按 line id 批量取价列。返回 Map<id, LineCost>。ids 为空返回空 Map。 */
export async function fetchLineCostsByIds(ids: string[]): Promise<Map<string, LineCost>> {
  const map = new Map<string, LineCost>();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (uniq.length === 0) return map;
  const svc = createServiceRoleClient();
  const { data } = await (svc.from('procurement_line_items') as any)
    .select('id, unit_price, ordered_amount, difference_amount').in('id', uniq);
  for (const r of (data || [])) {
    map.set((r as any).id, {
      unit_price: (r as any).unit_price ?? null,
      ordered_amount: (r as any).ordered_amount ?? null,
      difference_amount: (r as any).difference_amount ?? null,
    });
  }
  return map;
}
