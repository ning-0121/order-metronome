'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { isAdminRole } from '@/lib/domain/roles';
import { syncShipmentApprovalToFinance } from '@/lib/integration/finance-sync';

/** 读取当前用户角色集合（roles[] 优先，回退 role） */
async function getRoles(supabase: any, userId: string): Promise<string[]> {
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  return (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
}

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
  carton_count?: number;
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

  const row: Record<string, any> = {
    order_id: orderId,
    shipment_qty: rec.shipment_qty,
    carton_count: rec.carton_count != null && rec.carton_count > 0 ? rec.carton_count : null,   // 出货箱数
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
  };
  let { data: inserted, error } = await (supabase.from('shipment_confirmations') as any)
    .insert(row).select('id').single();
  // carton_count 列(20260711)未建 → 降级去掉重插,不 brick 出货申请
  if (error && /carton_count|column .* does not exist/i.test(error.message || '')) {
    delete row.carton_count;
    ({ data: inserted, error } = await (supabase.from('shipment_confirmations') as any)
      .insert(row).select('id').single());
  }
  if (error) return { error: error.message };

  // 推送出货财务审批请求 → 财务系统「集成审批」队列(fire-and-forget,永不阻塞出货申请;
  //   未配置 FINANCE_SYSTEM_URL 时 sendToFinanceSystem 内部静默跳过)。
  //   之前只在节拍器内部由 finance 角色审批,外部财务系统收不到 → 财务永远不知道要批。
  try {
    const { data: ord } = await (supabase.from('orders') as any)
      .select('order_no, internal_order_no, customer_name').eq('id', orderId).single();
    const { data: prof } = await (supabase.from('profiles') as any)
      .select('name, full_name').eq('user_id', user.id).maybeSingle();
    const requesterName = (prof as any)?.name || (prof as any)?.full_name || null;
    if (inserted?.id) {
      // 必须 await:Vercel serverless 下,Server Action 一返回就冻结 lambda,不 await 的 fetch 会被杀,
      // 财务收不到、连 outbox 都不落(2026-07-11 排障:cancel/milestone 都 await 能通,唯独出货 void 丢单)。
      // sendToFinanceSystem 内部已吞错+失败落 outbox,await 它不会阻断出货申请。
      await syncShipmentApprovalToFinance({
        id: inserted.id,
        order_no: (ord as any)?.order_no || null,
        customer_name: rec.customer_name || (ord as any)?.customer_name || null,
        requester_name: requesterName,
        summary: `申请出货 ${rec.shipment_qty} 件${rec.carton_count ? ` / ${rec.carton_count} 箱` : ''}`,
        detail: {
          internal_order_no: (ord as any)?.internal_order_no || null,
          shipment_qty: rec.shipment_qty,
          carton_count: rec.carton_count ?? null,
          order_qty: rec.order_qty ?? null,
          product_name: rec.product_name || null,
          delivery_method: rec.delivery_method || null,
          shipping_port: rec.shipping_port || null,
          destination_port: rec.destination_port || null,
          requested_ship_date: rec.requested_ship_date || null,
          ci_number: rec.ci_number || null,
        },
        created_at: new Date().toISOString(),
      }).catch((e: any) => console.error('[shipment→finance] 推送审批失败(不阻断):', e?.message));
    }
  } catch (e: any) {
    console.error('[shipment→finance] 组装审批载荷异常(不阻断):', e?.message);
  }

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

  // 仅财务/管理员可审批出货（原先任何登录用户都能批，越过财务闸门）
  const roles = await getRoles(supabase, user.id);
  if (!isAdminRole(roles) && !roles.includes('finance')) {
    return { error: '仅财务或管理员可审批出货' };
  }
  // 前置状态守卫：仅"业务已签、待财务"可审批，防重复审批 / 把已完成记录打回
  const { data: cur } = await (supabase.from('shipment_confirmations') as any)
    .select('status').eq('id', id).single();
  if (!cur) return { error: '出货记录不存在' };
  if (cur.status !== 'sales_signed') {
    return { error: `当前状态(${cur.status})不可审批，仅待财务审批的记录可操作` };
  }

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

  // 仅物流/管理员可执行出货
  const roles = await getRoles(supabase, user.id);
  if (!isAdminRole(roles) && !roles.includes('logistics')) {
    return { error: '仅物流或管理员可执行出货' };
  }
  // 前置状态守卫：必须财务审批通过(warehouse_signed)后才能执行，防绕过财务闸门
  const { data: cur } = await (supabase.from('shipment_confirmations') as any)
    .select('status').eq('id', id).single();
  if (!cur) return { error: '出货记录不存在' };
  if (cur.status !== 'warehouse_signed') {
    return { error: `需财务审批通过后才能执行出货，当前状态：${cur.status}` };
  }

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
