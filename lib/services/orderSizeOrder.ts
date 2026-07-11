/**
 * 取订单级尺码列手排顺序(orders.size_order)—— 业务在富录入表拖排、持久化的那份。
 * 全下游(生产任务单/PI/采购/出货)共用此取数,再交给 size-sort 的 orderSizeKeys/sizeComparator,
 * 保证到处跟业务手排一致。列缺失(迁移未执行)或无值 → 返回 null,下游回落标准自动排序。
 */
export async function fetchOrderSizeOrder(supabase: any, orderId: string | null | undefined): Promise<string[] | null> {
  if (!orderId) return null;
  const { data } = await (supabase.from('orders') as any).select('size_order').eq('id', orderId).maybeSingle();
  const so = (data as any)?.size_order;
  return Array.isArray(so) && so.length > 0 ? so.map((s: any) => String(s)) : null;
}
