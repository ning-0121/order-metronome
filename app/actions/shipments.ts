'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getShipmentConfirmation(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('shipment_confirmations') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function createShipmentConfirmation(orderId: string, rec: {
  shipment_qty: number; order_qty?: number; bl_number?: string; vessel_name?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!rec.shipment_qty || rec.shipment_qty <= 0) return { error: '出货数量必须大于0' };

  const { error } = await (supabase.from('shipment_confirmations') as any).insert({
    order_id: orderId,
    shipment_qty: rec.shipment_qty,
    order_qty: rec.order_qty || null,
    bl_number: rec.bl_number || null,
    vessel_name: rec.vessel_name || null,
    status: 'pending',
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function signShipment(id: string, orderId: string, signRole: 'sales' | 'warehouse' | 'finance', note?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const now = new Date().toISOString();
  const patch: Record<string, any> = {};

  if (signRole === 'sales') {
    patch.sales_sign_id = user.id;
    patch.sales_signed_at = now;
    if (note) patch.sales_note = note;
  } else if (signRole === 'warehouse') {
    patch.warehouse_sign_id = user.id;
    patch.warehouse_signed_at = now;
    if (note) patch.warehouse_note = note;
  } else if (signRole === 'finance') {
    patch.finance_sign_id = user.id;
    patch.finance_signed_at = now;
    if (note) patch.finance_note = note;
  }

  const { error } = await (supabase.from('shipment_confirmations') as any)
    .update(patch).eq('id', id);
  if (error) return { error: error.message };

  // 检查是否三方都已签核
  const { data: updated } = await (supabase.from('shipment_confirmations') as any)
    .select('sales_sign_id, warehouse_sign_id, finance_sign_id').eq('id', id).single();
  if (updated?.sales_sign_id && updated?.warehouse_sign_id && updated?.finance_sign_id) {
    await (supabase.from('shipment_confirmations') as any)
      .update({ status: 'fully_signed', locked_at: now }).eq('id', id);
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}
