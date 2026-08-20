'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { safeMutation } from '@/lib/db/safe-mutation';
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
  // R1-C 策略 B:物流建分批(单常是别人建的),session 被 RLS 滤 0 行 → 批次建了、
  // 订单永不标 is_split_shipment(两轨打架)。svc + 断言。
  const wSp = await safeMutation({ client: createServiceRoleClient(), table: 'orders', operation: 'update',
    payload: { is_split_shipment: true, total_batches: batches.length }, predicate: { id: orderId } });
  if (!wSp.ok) {
    return { error: `批次已创建,但订单分批标记未生效(${wSp.status}):${wSp.error}` };
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

  // ── 审计 2026-08-20(P1-4):此前本函数零鉴权、零闸门——任何登录人可把批次直改 shipped,
  //    完全绕过 markBatchStep 的「仅物流/生产管理 + 财务放货硬闸」。补同口径闸。
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { getUserRoles } = await import('@/lib/repositories/ordersRepo');
  const roles = await getUserRoles(supabase, user.id);
  const { isAdminRole } = await import('@/lib/domain/roles');
  const isAdmin = isAdminRole(roles);
  if (!isAdmin && !roles.some((r) => ['logistics', 'production_manager', 'order_manager', 'merchandiser', 'sales'].includes(r))) {
    return { error: '无权修改出货批次' };
  }
  const SHIPPED_STATES = new Set(['shipped', '已出运']);
  const { getBatchRef } = await import('@/lib/repositories/shipmentBatchesRepo');
  let shipOrderId: string | null = null;
  if (updates.status && SHIPPED_STATES.has(String(updates.status))) {
    const bRow = await getBatchRef(supabase, batchId);
    if (!bRow) return { error: '批次不存在' };
    shipOrderId = bRow.order_id;
    if (!isAdmin && !roles.some((r) => ['logistics', 'production_manager'].includes(r))) {
      return { error: '仅物流/生产管理/管理员可标记出运——请走「出货单据」按批确认流程。' };
    }
    if (!isAdmin) {
      const { createServiceRoleClient } = await import('@/lib/supabase/server');
      const { data: fin } = await (createServiceRoleClient().from('order_financials') as any)
        .select('payment_hold, allow_shipment').eq('order_id', (bRow as any).order_id).maybeSingle();
      if ((fin as any)?.payment_hold) return { error: '❌ 财务付款暂停中,不允许标记出运。' };
      if ((fin as any)?.allow_shipment !== true) return { error: '❌ 财务尚未放货,不能直接把批次标成已出运——请财务放行后走按批确认。' };
    }
  }

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

  // 直改批次为已出运 → 出货单据同步财务(与 markBatchStep 出运路径同口径;await 防 serverless 冻结丢事件)
  if (shipOrderId) {
    try {
      const { syncShippingDocsToFinance } = await import('@/app/actions/shipping-docs-sync');
      await syncShippingDocsToFinance(shipOrderId, batchId);
    } catch (e: any) { console.warn('[updateShipmentBatch] 出货单据同步失败(不阻断):', e?.message); }
  }
  return { success: true };
}
