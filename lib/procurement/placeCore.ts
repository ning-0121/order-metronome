import { revalidatePath } from 'next/cache';
import { syncPurchaseOrderToFinance } from '@/lib/integration/finance-sync';

/**
 * 采购单下单核心(draft → placed):状态推进 + 行→ordered + 财务应付同步(purchase_order.placed)
 * + 采购项联动 + 「采购下单」节点自动完成。
 *
 * 纯服务端函数,**非 server action(不对客户端暴露,避免无鉴权 place 被直调)**;
 * 由两方共用,鉴权在各自入口:
 *   - placePurchaseOrder(用户会话,CAN_PROCURE + 风险/审批闸后)
 *   - finance-callback(HMAC 验签,外部财务批准后自动下单)
 * 传入对应的 supabase client(用户会话 或 service-role)。
 */
export async function placePurchaseOrderCore(supabase: any, poId: string): Promise<{ ok?: boolean; error?: string }> {
  const { error } = await (supabase.from('purchase_orders') as any)
    .update({ status: 'placed', updated_at: new Date().toISOString() }).eq('id', poId);
  if (error) { try { revalidatePath(`/procurement/po/${poId}`); } catch { /* route 外调用无 revalidate 上下文 */ } return { error: error.message }; }

  // 该单的行 draft/pending_order → ordered,进「待催货」队列(失败不阻断)
  try {
    await (supabase.from('procurement_line_items') as any)
      .update({ line_status: 'ordered' }).eq('purchase_order_id', poId).in('line_status', ['draft', 'pending_order']);
  } catch (e: any) { console.warn('[placeCore] 行状态推进失败(不阻断):', e?.message); }

  // placed → 财务同步(应付/付款计划)+ 补采购预警;未配置即静默跳过,失败落 outbox
  try {
    const { data: full } = await (supabase.from('purchase_orders') as any).select('*').eq('id', poId).maybeSingle();
    if (full) {
      let supplements: Array<{ item_no?: string; material_name?: string; qty?: number; reason?: string }> = [];
      try {
        const { data: lines } = await (supabase.from('procurement_line_items') as any)
          .select('procurement_item_id').eq('purchase_order_id', poId).not('procurement_item_id', 'is', null);
        const piIds = [...new Set((lines || []).map((l: any) => l.procurement_item_id))];
        if (piIds.length > 0) {
          const { data: suppItems } = await (supabase.from('procurement_items') as any)
            .select('item_no, material_name, total_required_qty, supplement_reason').in('id', piIds).eq('is_supplement', true);
          supplements = (suppItems || []).map((s: any) => ({ item_no: s.item_no, material_name: s.material_name, qty: s.total_required_qty, reason: s.supplement_reason }));
        }
      } catch { /* 补采购列未建时静默 */ }
      await syncPurchaseOrderToFinance(full, undefined, supplements);
    }
  } catch { /* 财务同步失败不影响下单 */ }

  // placed → 关联采购项 confirmed→ordered(P0 复审修:传入本函数的 client,webhook 上下文无 cookie 会话会静默 no-op)
  try {
    const { syncProcurementItemsOrderedForPO } = await import('@/app/actions/procurement-items');
    await syncProcurementItemsOrderedForPO(poId, supabase);
  } catch (e: any) { console.warn('[placeCore] 采购项状态联动失败(不阻断):', e?.message); }
  // 全部采购项已下单 → 自动完成「采购下单」节点
  try {
    const { autoCompleteProcurementPlacedForPO } = await import('@/app/actions/procurement-items');
    await autoCompleteProcurementPlacedForPO(poId, supabase);
  } catch (e: any) { console.warn('[placeCore] 采购下单节点自动完成失败(不阻断):', e?.message); }

  try { revalidatePath(`/procurement/po/${poId}`); } catch { /* route 外调用无 revalidate 上下文 */ }
  return { ok: true };
}
