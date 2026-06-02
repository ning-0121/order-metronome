'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/**
 * 获取订单的分批出货记录
 */
export async function getShipmentBatches(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('shipment_batches') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('batch_no', { ascending: true });

  if (error) return { data: [], error: null }; // Table might not exist yet
  return { data: data || [], error: null };
}

/**
 * 标记订单为分批出货 + 创建批次
 */
export async function enableSplitShipment(
  orderId: string,
  batches: Array<{ quantity: number; etd?: string; notes?: string }>
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  if (batches.length < 2) return { error: '分批出货至少需要 2 批' };

  // ── 数量守恒校验（2026-05-18, P1）──
  // Σ batches.quantity 必须 = orders.quantity（允许 0 件容差）
  const { data: orderRow } = await (supabase.from('orders') as any)
    .select('quantity')
    .eq('id', orderId)
    .single();
  if (orderRow) {
    const { validateQuantityConservation } = await import('@/lib/domain/orderInvariants');
    const r = validateQuantityConservation({
      orderQuantity: (orderRow as any).quantity,
      batches: batches.map(b => ({ quantity: b.quantity })),
      toleranceUnits: 0,
    });
    if (!r.ok) return { error: r.message };
  }

  // ── 防丢数据：先快照旧批次，再删→插，插失败则回滚恢复（无事务环境下的补偿）──
  // 1. 快照旧批次（UNIQUE(order_id,batch_no) 约束下无法先插后删，故用「删后插+失败回滚」）
  const { data: oldBatches } = await (supabase.from('shipment_batches') as any)
    .select('*')
    .eq('order_id', orderId);

  // 2. 删除旧批次（检查 error，失败立即中止，不丢数据、不留半成品）
  const { error: delError } = await (supabase.from('shipment_batches') as any)
    .delete().eq('order_id', orderId);
  if (delError) {
    return { error: `清理旧批次失败：${delError.message}` };
  }

  // 3. 创建新批次
  const rows = batches.map((b, i) => ({
    order_id: orderId,
    batch_no: i + 1,
    quantity: b.quantity,
    etd: b.etd || null,
    notes: b.notes || null,
    status: 'planned',
    created_by: user.id,
  }));

  const { error } = await (supabase.from('shipment_batches') as any).insert(rows);
  if (error) {
    // 插入失败 → 回滚：把刚删掉的旧批次原样写回，避免数据永久丢失
    if (oldBatches && oldBatches.length > 0) {
      await (supabase.from('shipment_batches') as any).insert(oldBatches);
    }
    if (error.message?.includes('does not exist') || error.code === '42P01') {
      return { error: '分批出货功能正在初始化，请联系管理员执行数据库迁移' };
    }
    return { error: error.message };
  }

  // 4. 全部成功后才标记订单为分批出货（失败时订单不会被错误标记）
  const { error: orderError } = await (supabase.from('orders') as any)
    .update({ is_split_shipment: true, total_batches: batches.length })
    .eq('id', orderId);
  if (orderError) {
    return { error: `批次已创建，但订单标记更新失败：${orderError.message}` };
  }

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * 更新单个批次状态
 */
export async function updateShipmentBatch(
  batchId: string,
  updates: { status?: string; actual_ship_date?: string; bl_number?: string; vessel_name?: string; tracking_no?: string; notes?: string; quantity?: number }
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();

  // ── 如果修改了数量，校验数量守恒（2026-05-18, P1）──
  if (updates.quantity !== undefined) {
    const { data: batch } = await (supabase.from('shipment_batches') as any)
      .select('order_id')
      .eq('id', batchId)
      .single();
    if (batch) {
      const [{ data: orderRow }, { data: allBatches }] = await Promise.all([
        (supabase.from('orders') as any).select('quantity').eq('id', (batch as any).order_id).single(),
        (supabase.from('shipment_batches') as any).select('id, quantity').eq('order_id', (batch as any).order_id),
      ]);
      if (orderRow && allBatches) {
        // 用 updates.quantity 替换被改批次的数量后重新求和
        const merged = (allBatches as any[]).map(b =>
          b.id === batchId ? { quantity: updates.quantity! } : { quantity: b.quantity }
        );
        const { validateQuantityConservation } = await import('@/lib/domain/orderInvariants');
        const r = validateQuantityConservation({
          orderQuantity: (orderRow as any).quantity,
          batches: merged,
          toleranceUnits: 0,
        });
        if (!r.ok) return { error: r.message };
      }
    }
  }

  const { error } = await (supabase.from('shipment_batches') as any)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', batchId);

  if (error) return { error: error.message };
  return { success: true };
}
