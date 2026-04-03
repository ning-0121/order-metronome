'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getShipmentConfirmation(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('shipment_confirmations') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

/**
 * Step 2: 业务申请出货
 */
export async function createShipmentConfirmation(orderId: string, rec: {
  shipment_qty: number;
  order_qty?: number;
  customer_name?: string;
  product_name?: string;
  delivery_address?: string;
  delivery_method?: string;
  shipping_port?: string;
  destination_port?: string;
  ci_number?: string;
  requested_ship_date?: string;
  bl_number?: string;
  vessel_name?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!rec.shipment_qty || rec.shipment_qty <= 0) return { error: '出货数量必须大于0' };

  const { error } = await (supabase.from('shipment_confirmations') as any).insert({
    order_id: orderId,
    shipment_qty: rec.shipment_qty,
    order_qty: rec.order_qty || null,
    customer_name: rec.customer_name || null,
    product_name: rec.product_name || null,
    delivery_address: rec.delivery_address || null,
    delivery_method: rec.delivery_method || null,
    shipping_port: rec.shipping_port || null,
    destination_port: rec.destination_port || null,
    ci_number: rec.ci_number || null,
    requested_ship_date: rec.requested_ship_date || null,
    bl_number: rec.bl_number || null,
    vessel_name: rec.vessel_name || null,
    requested_by: user.id,
    sales_sign_id: user.id,
    sales_signed_at: new Date().toISOString(),
    status: 'sales_signed',
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * Step 3: 财务审批
 */
export async function approveShipment(id: string, orderId: string, decision: 'approved' | 'rejected', paymentStatus?: string, note?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const now = new Date().toISOString();
  const patch: Record<string, any> = {
    finance_sign_id: user.id,
    finance_signed_at: now,
    finance_decision: decision,
    finance_decision_note: note || null,
    payment_status: paymentStatus || null,
  };

  if (decision === 'approved') {
    patch.status = 'warehouse_signed'; // 进入物流步骤
  } else {
    patch.status = 'pending'; // 驳回回到待处理
    patch.finance_note = `驳回: ${note || ''}`;
  }

  const { error } = await (supabase.from('shipment_confirmations') as any)
    .update(patch).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * Step 4: 物流执行出货
 */
export async function executeShipment(id: string, orderId: string, rec: {
  actual_ship_date?: string;
  bl_number?: string;
  vessel_name?: string;
  container_no?: string;
  logistics_note?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const now = new Date().toISOString();
  const { error } = await (supabase.from('shipment_confirmations') as any)
    .update({
      warehouse_sign_id: user.id,
      warehouse_signed_at: now,
      actual_ship_date: rec.actual_ship_date || null,
      bl_number: rec.bl_number || null,
      vessel_name: rec.vessel_name || null,
      container_no: rec.container_no || null,
      logistics_note: rec.logistics_note || null,
      status: 'fully_signed',
      locked_at: now,
    }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/** 兼容旧的 signShipment（保留） */
export async function signShipment(id: string, orderId: string, signRole: 'sales' | 'warehouse' | 'finance', note?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const now = new Date().toISOString();
  const patch: Record<string, any> = {};
  if (signRole === 'sales') { patch.sales_sign_id = user.id; patch.sales_signed_at = now; if (note) patch.sales_note = note; }
  else if (signRole === 'warehouse') { patch.warehouse_sign_id = user.id; patch.warehouse_signed_at = now; if (note) patch.warehouse_note = note; }
  else if (signRole === 'finance') { patch.finance_sign_id = user.id; patch.finance_signed_at = now; if (note) patch.finance_note = note; }

  const { error } = await (supabase.from('shipment_confirmations') as any).update(patch).eq('id', id);
  if (error) return { error: error.message };
  const { data: updated } = await (supabase.from('shipment_confirmations') as any)
    .select('sales_sign_id, warehouse_sign_id, finance_sign_id').eq('id', id).single();
  if (updated?.sales_sign_id && updated?.warehouse_sign_id && updated?.finance_sign_id) {
    await (supabase.from('shipment_confirmations') as any).update({ status: 'fully_signed', locked_at: now }).eq('id', id);
  }
  revalidatePath(`/orders/${orderId}`);
  return {};
}
