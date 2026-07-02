'use server';

/**
 * Order Intake — PO 路径（Order Intake Convergence）
 *
 * Order = approved PO 快照的物化产物（derived output），非用户录入实体。
 * 流程：Router → Kernel → 消费闸门(snapshot 真相) → buildOrderFromPO → 复用既有 createOrder → 附加绑定。
 *
 * 安全铁律：
 *   - **不改 legacy createOrder**：本路径复用它（里程碑/排期全走既有管线），只在建成后 UPDATE 绑定列。
 *   - **不重算 price/cost/margin**：商务字段逐字继承 approved 快照。
 *   - Order 自有运营字段（内部单号/工厂/交期/样品阶段）由本层传入（Contract §三：Order 自填内部字段）。
 *   - snapshot 非 approved → HARD FAIL（buildOrderFromPO 抛错）。
 */

import { createClient } from '@/lib/supabase/server';
import { OrderIntakeRouter } from '@/lib/order/intake-router';
import { buildOrderFromPO } from '@/lib/order/from-po';
import { getApprovedQuoteForCompare } from '@/app/actions/quote-consumption';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';

export interface CreateOrderFromPOInput {
  customerPoId: string;
  /** Order 自有运营字段（PO/快照不拥有；Contract §三 内部字段） */
  operational: {
    internal_order_no: string;
    incoterm: string;
    order_type: string;
    factory_date: string;
    delivery_type?: string;
    factory_id?: string;
    factory_name?: string;
    etd?: string;
    warehouse_due_date?: string;
    order_date?: string;
    cancel_date?: string;
    sample_phase?: string;
    aql_standard?: string;
    shipping_sample_required?: boolean;
    shipping_sample_deadline?: string;
    risk_flags?: string[]; // checkbox 键名:has_plus_size/high_stretch/light_color_risk/color_clash_risk/complex_print/tight_deadline
    order_purpose?: string;
    quantity_unit?: string;
  };
}

export async function createOrderFromPO(
  input: CreateOrderFromPOInput,
): Promise<{ ok: boolean; orderId?: string; error?: string; mode?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  // PO 绑定（唯一 truth binding source）
  const { data: po } = await (supabase.from('customer_po') as any)
    .select('*').eq('id', input.customerPoId).maybeSingle();
  if (!po) return { ok: false, error: 'PO 不存在' };

  // 唯一决策入口（Kernel 判准入；Router 只分发）
  const decision = OrderIntakeRouter({
    source: 'po',
    user: { id: user.id, email: user.email || user.id, roles },
    po: { customerPoId: (po as any).id, quoteId: (po as any).quote_id },
  });
  if (decision.mode !== 'PO' || !decision.allow) {
    return { ok: false, error: `order_intake_blocked:${decision.reason}`, mode: decision.mode };
  }

  // 消费闸门（snapshot 真相层）→ buildOrderFromPO 硬门（非 approved 抛错）
  const basis = await getApprovedQuoteForCompare((po as any).quote_id);
  let draft;
  try {
    draft = buildOrderFromPO(po as any, basis);
  } catch (e: any) {
    return { ok: false, error: `snapshot_gate:${e.message}` };
  }

  // 系统生成订单号
  const pre = await preGenerateOrderNo();
  if (!('orderNo' in pre) || !pre.orderNo) {
    return { ok: false, error: ('error' in pre && pre.error) || '订单号生成失败' };
  }

  // 组装 FormData：继承商务字段（快照）+ 运营字段（Order 自有）
  const fd = new FormData();
  fd.set('customer_id', draft.customer_id);
  fd.set('customer_name', draft.customer_name || '');
  fd.set('customer_po_number', draft.customer_po_number || '');
  const totalQty = (draft.lines as any[]).reduce((s, l) => s + (Number(l?.quantity) || 0), 0);
  fd.set('total_quantity', String(totalQty));
  fd.set('quantity_unit', input.operational.quantity_unit || '件');
  fd.set('style_count', String((draft.lines as any[]).length || 1));

  const op = input.operational;
  fd.set('internal_order_no', op.internal_order_no);
  fd.set('incoterm', op.incoterm);
  fd.set('order_type', op.order_type);
  fd.set('factory_date', op.factory_date);
  fd.set('order_purpose', op.order_purpose || 'production');
  if (op.factory_id) fd.set('factory_id', op.factory_id);
  if (op.factory_name) fd.set('factory_name', op.factory_name);
  if (op.etd) fd.set('etd', op.etd);
  if (op.warehouse_due_date) fd.set('warehouse_due_date', op.warehouse_due_date);
  if (op.order_date) fd.set('order_date', op.order_date);
  if (op.cancel_date) fd.set('cancel_date', op.cancel_date);
  if (op.sample_phase) fd.set('sample_phase', op.sample_phase);
  // P1b:补齐 legacy 认的运营键(交付方式/AQL/shipping sample/风险标记)
  if (op.delivery_type) fd.set('delivery_type', op.delivery_type);
  if (op.aql_standard) fd.set('aql_standard', op.aql_standard);
  if (op.shipping_sample_required) {
    fd.set('shipping_sample_required', 'true');
    if (op.shipping_sample_deadline) fd.set('shipping_sample_deadline', op.shipping_sample_deadline);
  }
  for (const k of (op.risk_flags || [])) fd.set(k, 'true'); // 每个风险 checkbox 键置 'true'

  // 复用既有 createOrder 管线（里程碑/排期/财务）—— legacy 逻辑零改动
  const res = await createOrder(fd, pre.orderNo);
  if (!res.ok || !res.orderId) return { ok: false, error: res.error || '建单失败' };

  // 附加 PO 绑定（新列；legacy 从不写这些）
  const { error: bindErr } = await (supabase.from('orders') as any)
    .update({
      source: 'PO',
      customer_po_id: (po as any).id,
      quote_id: (po as any).quote_id,
      quote_snapshot_version: (po as any).quote_snapshot_version,
      origin_quote_id: (po as any).quote_id,
    })
    .eq('id', res.orderId);
  if (bindErr) return { ok: false, orderId: res.orderId, error: '订单已建但绑定写入失败：' + bindErr.message };

  return { ok: true, orderId: res.orderId };
}

/**
 * P1b:客户上次订单的运营默认值(主数据预填,不靠 AI)。
 * customers 表无默认列 → 取该客户最近一张订单实际用过的值,比静态默认更准。全部可覆盖。
 */
export async function getCustomerOrderDefaults(
  customerId: string,
): Promise<{ data: Record<string, any> | null }> {
  if (!customerId) return { data: null };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null };
  const { data } = await (supabase.from('orders') as any)
    .select('order_type, incoterm, delivery_type, factory_name, factory_id, aql_standard, sample_phase')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: (data as any) || null };
}
