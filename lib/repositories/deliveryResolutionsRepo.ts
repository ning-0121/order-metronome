// ============================================================
// Delivery Resolutions Repository —— 逾期处置的数据访问收口
//
// 2026-08-20 建:app/actions/delivery-resolution.ts 里原本裸 .from() 直连
// (order_delivery_resolutions ×7 / orders ×2 / profiles ×1),被 lint:data-access 拦下。
// 按 ADR-006 棘轮:新读写一律收口 repository,不给业务层开白名单。
//
// 本文件只做 persistence:「能不能处置、批不批、红条该不该消失」这些判定留在 action,
// 这里只回答「库里有没有 / 写没写进去」。
// 交期真相仍在 orders.factory_date / etd —— applyOrderDeliveryDates 是唯一写回口。
// ============================================================

import { createServiceRoleClient } from '@/lib/supabase/server';

export interface ResolutionInsert {
  orderId: string;
  resolutionType: string;
  newFactoryDate: string | null;
  newEtd: string | null;
  customerResponse: string;
  customerConfirmedAt: string | null;
  evidencePath: string | null;
  costAmount: number | null;
  costKind: string | null;
  reason: string;
  requestedBy: string;
}

/** 订单摘要(发起处置时做存在性校验 + 通知文案用)。 */
export async function readOrderBrief(orderId: string): Promise<{
  order: { id: string; ref: string; customerName: string | null } | null; error: string | null;
}> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('orders') as any)
    .select('id, internal_order_no, order_no, customer_name').eq('id', orderId).maybeSingle();
  if (error) return { order: null, error: error.message };
  if (!data) return { order: null, error: null };
  const d = data as any;
  return { order: { id: d.id, ref: d.internal_order_no || d.order_no || String(d.id).slice(0, 8), customerName: d.customer_name ?? null }, error: null };
}

/** 建处置申请。唯一索引保证一单同时只有一个未结,冲突时返回可读原因。 */
export async function insertResolution(input: ResolutionInsert): Promise<{ id: string | null; error: string | null; conflict?: boolean }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_delivery_resolutions') as any).insert({
    order_id: input.orderId,
    resolution_type: input.resolutionType,
    new_factory_date: input.newFactoryDate,
    new_etd: input.newEtd,
    customer_response: input.customerResponse,
    customer_confirmed_at: input.customerConfirmedAt,
    evidence_path: input.evidencePath,
    cost_amount: input.costAmount,
    cost_kind: input.costKind,
    reason: input.reason,
    requested_by: input.requestedBy,
  }).select('id').single();
  if (error) {
    const conflict = /duplicate key|uq_odr_one_open_per_order/i.test(error.message);
    return { id: null, error: error.message, conflict };
  }
  return { id: (data as any)?.id ?? null, error: null };
}

export async function readResolution(id: string): Promise<{ row: any | null; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_delivery_resolutions') as any)
    .select('*').eq('id', id).maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ?? null, error: null };
}

/** 某单当前未结的处置(pending / om_approved)。 */
export async function readOpenResolution(orderId: string): Promise<{ row: any | null; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_delivery_resolutions') as any)
    .select('*').eq('order_id', orderId).in('status', ['pending', 'om_approved'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: data ?? null, error: null };
}

/**
 * 推进审批状态。CAS(带 expectFrom)—— 命中 0 行说明状态已被别人改过,
 * 必须报错而不是静默成功(否则会出现"两个人各批一次、写回两遍交期")。
 */
export async function advanceResolutionStatus(
  id: string,
  expectFrom: string[],
  patch: Record<string, any>,
): Promise<{ ok: boolean; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_delivery_resolutions') as any)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).in('status', expectFrom).select('id');
  if (error) return { ok: false, error: error.message };
  if (!data || data.length !== 1) return { ok: false, error: '状态已变(可能已被他人处理),请刷新重试' };
  return { ok: true, error: null };
}

/** 标记已写回订单(幂等闸)。 */
export async function markResolutionApplied(id: string): Promise<{ error: string | null }> {
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('order_delivery_resolutions') as any)
    .update({ applied_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

/**
 * 把批准后的新交期写回订单 —— **唯一**写回口。
 * 断言恰好 1 行生效:0 行意味着订单不存在或被并发删改,不能当成功。
 */
export async function applyOrderDeliveryDates(
  orderId: string,
  dates: { factoryDate?: string | null; etd?: string | null },
): Promise<{ ok: boolean; changed: Record<string, any>; error: string | null }> {
  const patch: Record<string, any> = {};
  if (dates.factoryDate) patch.factory_date = dates.factoryDate;
  if (dates.etd) patch.etd = dates.etd;
  if (Object.keys(patch).length === 0) return { ok: true, changed: {}, error: null };
  patch.updated_at = new Date().toISOString();
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('orders') as any)
    .update(patch).eq('id', orderId).select('id');
  if (error) return { ok: false, changed: patch, error: error.message };
  if (!data || data.length !== 1) return { ok: false, changed: patch, error: `写回订单交期影响 ${(data || []).length} 行(期望 1)` };
  return { ok: true, changed: patch, error: null };
}
