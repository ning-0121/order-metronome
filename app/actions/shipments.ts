'use server';

import { createClient } from '@/lib/supabase/server';
import { safeMutation } from '@/lib/db/safe-mutation';
import { writeAuditEvent } from '@/lib/audit/write-audit-event';
import { revalidatePath } from 'next/cache';
import { isAdminRole } from '@/lib/domain/roles';
import { syncShipmentApprovalToFinance, syncShipmentApprovalCancelledToFinance } from '@/lib/integration/finance-sync';

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
 * Step 2.5: 撤回出货申请(2026-07-11 用户:提交后发现数量错等,之前无法回退只能等财务批/驳)。
 * 仅「待财务审批(sales_signed)」可撤;财务已批(warehouse_signed)后不可撤,走正常流程。
 * 撤回 = 退回 pending(与财务驳回同语义,UI 已支持重新申请)+ 同步财务把队列那条置 expired。
 * 权限:申请人本人 / 业务 / 财务 / 管理员。
 */
export async function withdrawShipmentApplication(id: string, orderId: string, reason?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: cur } = await (supabase.from('shipment_confirmations') as any)
    .select('status, requested_by').eq('id', id).single();
  if (!cur) return { error: '出货申请不存在' };
  if (cur.status !== 'sales_signed') {
    return { error: cur.status === 'warehouse_signed' || cur.status === 'fully_signed'
      ? '财务已审批通过,不可撤回;如需变更请联系财务/管理员处理'
      : `当前状态(${cur.status})无需撤回` };
  }

  const roles = await getRoles(supabase, user.id);
  const isRequester = cur.requested_by === user.id;
  if (!isRequester && !isAdminRole(roles) && !roles.some((r: string) => ['sales', 'merchandiser', 'order_manager', 'finance'].includes(r))) {
    return { error: '仅申请人、业务、财务或管理员可撤回出货申请' };
  }

  // 状态闸并发保护:仅 sales_signed → pending;财务恰好同时批了则 0 行,明确报错而非假装成功。
  // sales_sign_id 必须一并清空:trg_update_shipment_status 按签名字段推导状态,不清的话
  // pending 行日后任何一次 update 都会被推导回 sales_signed(迁移 20260711_..._respect_explicit 配套)。
  const { data: upd, error } = await (supabase.from('shipment_confirmations') as any)
    .update({ status: 'pending', sales_sign_id: null, sales_signed_at: null, finance_note: `[撤回] ${reason || '业务撤回重报'}` })
    .eq('id', id).eq('status', 'sales_signed').select('id');
  if (error) return { error: error.message };
  if (!upd || upd.length === 0) return { error: '撤回失败:状态已变化(可能财务刚审批),请刷新查看' };

  // 同步财务撤队列(必须 await —— Vercel 上 fire-and-forget 会被冻结丢掉,2026-07-11 教训)
  try {
    const { data: ord } = await (supabase.from('orders') as any)
      .select('order_no').eq('id', orderId).maybeSingle();
    await syncShipmentApprovalCancelledToFinance({
      id, order_no: (ord as any)?.order_no || null, reason: reason || '业务撤回重报',
    });
  } catch (e: any) {
    console.error('[shipment→finance] 撤回同步失败(节拍器已撤,财务队列可能残留):', e?.message);
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

  // 财务批准出货 = 打开 allow_shipment 放行闸。走**统一放货 Command**(与外部财务回调同一套业务真相:
  // 开闸 + A2 审计 + 写后回读)。仅批准分支开,驳回不动。
  if (decision === 'approved') {
    const { createServiceRoleClient } = await import('@/lib/supabase/server');
    const { approveShipmentRelease } = await import('@/lib/shipment/approve-release');
    const svc = createServiceRoleClient();
    const rel = await approveShipmentRelease(svc, {
      orderId, approvedBy: user.id, source: 'internal', reason: note || null,
    });
    if (!rel.ok) return { error: `出货已批但放行闸开启失败(${rel.status}):${rel.error} —— 请重试或联系管理员` };
  }

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
    .select('status, shipment_qty').eq('id', id).single();
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

  // ── 出货事实 → 财务(审计 2026-08-19 P0-1)──
  // 此前物流三签出完货(提单号都录了)财务零事件:应收/CI/结算全不触发,
  // 与 confirmOrderShipped 是同一事实的两条写入路径、只有一条通知财务的教科书案例。
  // 必须 await:serverless 一返回就冻结,不 await 连 outbox 都进不去(2026-07-11 已排明)。
  try {
    const { getOrderShipmentRef } = await import('@/lib/repositories/ordersRepo');
    const ord = await getOrderShipmentRef(supabase, orderId);
    const { notifyShipmentCompleted } = await import('@/lib/integration/finance-sync');
    const r = await notifyShipmentCompleted({
      order_id: orderId,
      internal_order_no: (ord as any)?.internal_order_no || (ord as any)?.order_no || null,
      shipment_date: (rec.actual_ship_date || now).slice(0, 10),
      quantity: Number(cur.shipment_qty) || (ord as any)?.quantity || null,
      reference: rec.bl_number || null,
      shipment_confirmation_id: id,
    });
    if (!r.success) console.error(`[executeShipment] shipment.completed 首发失败(${r.error}) → 已落 outbox 待重试`);
    const { syncShippingDocsToFinance } = await import('@/app/actions/shipping-docs-sync');
    await syncShippingDocsToFinance(orderId);   // CI/装箱单/应收金额同步(内部吞错,不阻断)
  } catch (e: any) {
    console.error('[executeShipment] 财务事件发送异常(不阻断出货,outbox 兜底):', e?.message);
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}

// signShipment(遗留)已删除(2026-08-11 审计):无角色校验、无 allow_shipment 闸、无状态守卫的
// 'use server' 导出 = 任意登录用户可直接调用把出货签成 fully_signed、绕过财务审批。UI 已无调用方。
// 出货三签走 createShipmentConfirmation → approveShipment → executeShipment(各带权限+闸)。
