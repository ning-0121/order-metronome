'use server';

/**
 * 订单经营数据 — 利润 + 收款 + 控制开关
 *
 * 权限：
 * - 查看：所有参与订单的人
 * - 修改经营数据：admin / finance
 * - 标记收款：admin / finance
 * - 控制开关（allow_production/allow_shipment）：admin / finance
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface OrderFinancials {
  id: string;
  order_id: string;
  sale_price_per_piece: number | null;
  sale_currency: string;
  sale_total: number | null;
  exchange_rate: number;
  cost_material: number;
  cost_cmt: number;
  cost_shipping: number;
  cost_other: number;
  cost_total: number;
  gross_profit_rmb: number | null;
  margin_pct: number | null;
  min_margin_alert: boolean;
  deposit_rate: number | null;
  deposit_amount: number | null;
  deposit_received: number;
  deposit_received_at: string | null;
  deposit_status: string;
  balance_amount: number | null;
  balance_received: number;
  balance_received_at: string | null;
  balance_due_date: string | null;
  balance_status: string;
  payment_hold: boolean;
  allow_production: boolean;
  allow_shipment: boolean;
}

const CONFIRM_MODULES = ['fabric_color', 'size_breakdown', 'logo_print', 'packaging_label'] as const;

/**
 * 获取订单经营数据（不存在则自动创建）
 */
export async function getOrderFinancials(orderId: string): Promise<{ data?: OrderFinancials; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  let { data } = await (supabase.from('order_financials') as any)
    .select('*').eq('order_id', orderId).maybeSingle();

  // 不存在则自动创建（含从 cost_baseline 同步成本）
  if (!data) {
    const initResult = await initOrderFinancials(orderId);
    if (initResult.error) return { error: initResult.error };
    const { data: newData } = await (supabase.from('order_financials') as any)
      .select('*').eq('order_id', orderId).maybeSingle();
    data = newData;
  }

  return { data: data as OrderFinancials };
}

/**
 * 初始化订单经营数据 + 4 个确认模块
 */
export async function initOrderFinancials(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 读取订单基本信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, quantity, unit_price, currency, total_amount, incoterm')
    .eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };

  // 读取成本基线（如果有）
  const { data: baseline } = await (supabase.from('order_cost_baseline') as any)
    .select('total_cost_per_piece, fob_price, ddp_price, cmt_factory_quote, budget_fabric_amount, exchange_rate')
    .eq('order_id', orderId).maybeSingle();

  const qty = order.quantity || 0;
  const salePrice = order.unit_price || (order.incoterm === 'DDP' ? baseline?.ddp_price : baseline?.fob_price) || 0;
  const exchangeRate = baseline?.exchange_rate || 7.2;
  const saleTotal = salePrice * qty * (order.currency === 'CNY' ? 1 : exchangeRate);
  const costPerPiece = baseline?.total_cost_per_piece || 0;
  const costMaterial = baseline?.budget_fabric_amount || 0;
  const costCmt = (baseline?.cmt_factory_quote || 0) * qty;
  const costTotal = costPerPiece * qty;
  const grossProfit = saleTotal - costTotal;
  const marginPct = saleTotal > 0 ? Number(((grossProfit / saleTotal) * 100).toFixed(1)) : 0;

  // 插入 order_financials
  const { error: finError } = await (supabase.from('order_financials') as any).upsert({
    order_id: orderId,
    sale_price_per_piece: salePrice || null,
    sale_currency: order.currency || 'USD',
    sale_total: saleTotal || null,
    exchange_rate: exchangeRate,
    cost_material: costMaterial,
    cost_cmt: costCmt,
    gross_profit_rmb: grossProfit || null,
    margin_pct: marginPct || null,
    min_margin_alert: marginPct < 8,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'order_id' });
  // 财务记录写失败不再静默：返回 error 让调用方可感知（建单主链路仍由调用方决定是否阻断）
  if (finError) {
    console.error('[initOrderFinancials] 财务记录初始化失败:', finError.message);
    return { error: `财务记录初始化失败：${finError.message}` };
  }

  // 初始化 4 个确认模块（如果不存在）
  for (const module of CONFIRM_MODULES) {
    const { error: confError } = await (supabase.from('order_confirmations') as any).upsert({
      order_id: orderId,
      module,
      status: 'not_started',
      data: {},
    }, { onConflict: 'order_id,module' });
    if (confError) {
      console.error(`[initOrderFinancials] 确认模块 ${module} 初始化失败:`, confError.message);
      return { error: `确认模块初始化失败：${confError.message}` };
    }
  }

  return {};
}

/**
 * 更新经营数据（仅 admin / finance）
 */
export async function updateOrderFinancials(
  orderId: string,
  updates: Partial<Pick<OrderFinancials,
    'sale_price_per_piece' | 'sale_currency' | 'sale_total' | 'exchange_rate' |
    'cost_shipping' | 'cost_other' |
    'deposit_rate' | 'deposit_amount' | 'balance_amount' | 'balance_due_date' |
    'allow_production' | 'allow_shipment' | 'payment_hold'
  >>,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 权限：admin / finance
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  if (!roles.some(r => ['admin', 'finance'].includes(r))) {
    return { error: '仅财务和管理员可修改经营数据' };
  }

  // 自动计算利润
  if (updates.sale_price_per_piece !== undefined || updates.sale_total !== undefined || updates.exchange_rate !== undefined) {
    const { data: current } = await (supabase.from('order_financials') as any)
      .select('*').eq('order_id', orderId).single();
    const { data: order } = await (supabase.from('orders') as any)
      .select('quantity').eq('id', orderId).single();

    const qty = order?.quantity || 0;
    const price = updates.sale_price_per_piece ?? current?.sale_price_per_piece ?? 0;
    const rate = updates.exchange_rate ?? current?.exchange_rate ?? 7.2;
    const currency = updates.sale_currency ?? current?.sale_currency ?? 'USD';
    const saleTotal = updates.sale_total ?? (price * qty * (currency === 'CNY' ? 1 : rate));
    const costTotal = current?.cost_total || 0;
    const grossProfit = saleTotal - costTotal;
    const marginPct = saleTotal > 0 ? Number(((grossProfit / saleTotal) * 100).toFixed(1)) : 0;

    (updates as any).sale_total = saleTotal;
    (updates as any).gross_profit_rmb = grossProfit;
    (updates as any).margin_pct = marginPct;
    (updates as any).min_margin_alert = marginPct < 8;
  }

  // ── 金额守恒校验（2026-05-18, P1）──
  // 定金 + 尾款 ≈ 销售总额（容差 0.01 CNY）
  // 如果只录入部分字段（如先录销售额、定金/尾款待算），跳过校验
  if (updates.deposit_amount !== undefined || updates.balance_amount !== undefined || (updates as any).sale_total !== undefined) {
    const { data: existing } = await (supabase.from('order_financials') as any)
      .select('sale_total, deposit_amount, balance_amount')
      .eq('order_id', orderId)
      .single();
    const merged = {
      sale_total: (updates as any).sale_total ?? (existing as any)?.sale_total,
      deposit_amount: updates.deposit_amount ?? (existing as any)?.deposit_amount,
      balance_amount: updates.balance_amount ?? (existing as any)?.balance_amount,
    };
    const { validateAmountConservation } = await import('@/lib/domain/orderInvariants');
    const r = validateAmountConservation({
      saleTotal: merged.sale_total,
      depositAmount: merged.deposit_amount,
      balanceAmount: merged.balance_amount,
      toleranceCny: 0.01,
    });
    if (!r.ok) return { error: r.message };
  }

  const { error } = await (supabase.from('order_financials') as any)
    .update({ ...updates, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq('order_id', orderId);

  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 标记收款（仅 admin / finance）
 */
export async function recordPayment(
  orderId: string,
  type: 'deposit' | 'balance',
  amount: number,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  if (!roles.some(r => ['admin', 'finance'].includes(r))) {
    return { error: '仅财务和管理员可标记收款' };
  }
  if (!(amount > 0)) return { error: '收款金额必须大于 0' };

  // 读当前累计，本次金额按"增量"累加（原先是覆盖 + 一律标全收，分次收款会错）
  const { data: fin } = await (supabase.from('order_financials') as any)
    .select('deposit_amount, deposit_received, balance_amount, balance_received')
    .eq('order_id', orderId).single();

  const now = new Date().toISOString();
  const updates: any = { updated_by: user.id, updated_at: now };

  if (type === 'deposit') {
    const cum = (Number((fin as any)?.deposit_received) || 0) + amount;
    const due = Number((fin as any)?.deposit_amount) || 0;
    updates.deposit_received = cum;
    updates.deposit_received_at = now;
    updates.deposit_status = due > 0 && cum + 0.01 >= due ? 'received' : 'partial';
  } else {
    const cum = (Number((fin as any)?.balance_received) || 0) + amount;
    const due = Number((fin as any)?.balance_amount) || 0;
    updates.balance_received = cum;
    updates.balance_received_at = now;
    updates.balance_status = due > 0 && cum + 0.01 >= due ? 'received' : 'partial';
  }

  const { error } = await (supabase.from('order_financials') as any)
    .update(updates).eq('order_id', orderId);

  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 获取订单确认链（4 个模块）
 */
export async function getOrderConfirmations(orderId: string): Promise<{
  data?: Array<{
    module: string;
    status: string;
    data: any;
    customer_confirmed: boolean;
    confirmed_at: string | null;
    attachments: any[];
  }>;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data, error } = await (supabase.from('order_confirmations') as any)
    .select('*').eq('order_id', orderId).order('created_at');

  if (error) return { error: error.message };

  // 确保 4 个模块都存在
  if (!data || data.length < 4) {
    await initOrderFinancials(orderId);
    const { data: refreshed } = await (supabase.from('order_confirmations') as any)
      .select('*').eq('order_id', orderId).order('created_at');
    return { data: refreshed || [] };
  }

  return { data: data || [] };
}

/**
 * 更新确认模块状态和数据
 */
export async function updateConfirmation(
  orderId: string,
  module: string,
  updates: {
    status?: string;
    data?: any;
    customer_confirmed?: boolean;
    customer_evidence_url?: string;
    notes?: string;
  },
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 角色守卫：确认链会改 customer_confirmed（影响出货门禁），限运营角色
  const { data: confProfile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const confRoles: string[] = (confProfile as any)?.roles?.length > 0
    ? (confProfile as any).roles
    : [(confProfile as any)?.role].filter(Boolean);
  if (!confRoles.some(r => ['admin', 'finance', 'sales', 'merchandiser', 'sales_manager', 'order_manager'].includes(r))) {
    return { error: '无权操作确认链' };
  }

  // 获取当前状态（用于记录历史）
  const { data: current } = await (supabase.from('order_confirmations') as any)
    .select('status, history').eq('order_id', orderId).eq('module', module).single();

  const history = current?.history || [];
  if (updates.status && updates.status !== current?.status) {
    history.push({
      from: current?.status,
      to: updates.status,
      by: user.id,
      at: new Date().toISOString(),
    });
  }

  const dbUpdates: any = {
    ...updates,
    history,
    updated_at: new Date().toISOString(),
  };

  // 如果标记为 confirmed
  if (updates.status === 'confirmed') {
    dbUpdates.confirmed_by = user.id;
    dbUpdates.confirmed_at = new Date().toISOString();
  }
  if (updates.status === 'rejected') {
    dbUpdates.rejected_by = user.id;
  }

  const { error } = await (supabase.from('order_confirmations') as any)
    .update(dbUpdates).eq('order_id', orderId).eq('module', module);

  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 批量初始化所有老订单的确认链（状态设为 confirmed）
 * 用于确认链功能上线后，给已有订单补数据，避免阻塞
 */
export async function backfillConfirmationsForExistingOrders(): Promise<{
  processed: number;
  skipped: number;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { processed: 0, skipped: 0, error: '未登录' };

  const { data: orders } = await (supabase.from('orders') as any)
    .select('id').not('lifecycle_status', 'in', '("cancelled","已取消")');

  if (!orders) return { processed: 0, skipped: 0 };

  let processed = 0;
  let skipped = 0;

  for (const order of orders as any[]) {
    const { count } = await (supabase.from('order_confirmations') as any)
      .select('id', { count: 'exact', head: true })
      .eq('order_id', order.id);

    if (count && count >= 4) { skipped++; continue; }

    for (const mod of CONFIRM_MODULES) {
      await (supabase.from('order_confirmations') as any).upsert({
        order_id: order.id,
        module: mod,
        status: 'confirmed',
        customer_confirmed: true,
        confirmed_at: new Date().toISOString(),
        confirmed_by: user.id,
        data: {},
        notes: '系统自动补建（老订单默认已确认）',
      }, { onConflict: 'order_id,module' });
    }

    const { data: existingFin } = await (supabase.from('order_financials') as any)
      .select('id').eq('order_id', order.id).maybeSingle();
    if (!existingFin) {
      await (supabase.from('order_financials') as any).insert({
        order_id: order.id, allow_production: true, allow_shipment: true,
      });
    }

    processed++;
  }

  return { processed, skipped };
}
