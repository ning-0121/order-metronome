'use server';

/**
 * 订单经营状态 — Server Action 包装层
 *
 * 1. 从 DB 加载原始数据
 * 2. 喂给 engine 计算
 * 3. 返回 OrderBusinessState 给 UI
 * 4. 支持 admin override + 审计日志
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  computeOrderBusinessState,
  type OrderBusinessState,
  type EngineInput,
} from '@/lib/engine/orderBusinessEngine';

/**
 * 获取订单经营状态（一次调用，返回所有计算结果）
 */
export async function getOrderBusinessState(orderId: string): Promise<{
  data?: OrderBusinessState;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 并行加载所有数据
  const [orderRes, financialsRes, confirmationsRes, milestonesRes] = await Promise.all([
    (supabase.from('orders') as any)
      .select('id, order_no, quantity, incoterm, factory_date, is_new_customer, is_new_factory, special_tags, lifecycle_status')
      .eq('id', orderId)
      .single(),
    (supabase.from('order_financials') as any)
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle(),
    (supabase.from('order_confirmations') as any)
      .select('module, status, data, customer_confirmed')
      .eq('order_id', orderId),
    (supabase.from('milestones') as any)
      .select('step_key, status, due_at')
      .eq('order_id', orderId),
  ]);

  if (!orderRes.data) return { error: '订单不存在' };

  // 如果没有 financials 记录，自动初始化
  if (!financialsRes.data) {
    try {
      const { initOrderFinancials } = await import('@/app/actions/order-financials');
      await initOrderFinancials(orderId);
      // 重新查询
      const { data: newFinancials } = await (supabase.from('order_financials') as any)
        .select('*').eq('order_id', orderId).maybeSingle();
      financialsRes.data = newFinancials;
    } catch {}
  }

  const input: EngineInput = {
    order: {
      ...orderRes.data,
      is_new_customer: orderRes.data.is_new_customer ?? false,
      is_new_factory: orderRes.data.is_new_factory ?? false,
      special_tags: orderRes.data.special_tags || [],
    },
    financials: financialsRes.data || null,
    confirmations: confirmationsRes.data || [],
    milestones: milestonesRes.data || [],
  };

  const state = computeOrderBusinessState(input);
  return { data: state };
}

/**
 * Admin Override — 强制覆盖某个经营控制开关
 *
 * 支持覆盖：allow_production / allow_shipment / payment_hold
 * 写审计日志到 order_financials.history（通过 milestone_logs 记录）
 */
export async function overrideBusinessControl(
  orderId: string,
  field: 'allow_production' | 'allow_shipment' | 'payment_hold',
  value: boolean,
  reason: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 权限：仅 admin / finance
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles, name, email').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  if (!roles.some(r => ['admin', 'finance'].includes(r))) {
    return { error: '仅管理员和财务可以覆盖经营控制' };
  }

  // 更新
  const { error } = await (supabase.from('order_financials') as any)
    .update({
      [field]: value,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId);

  if (error) return { error: error.message };

  // 写审计日志到 order_logs
  const fieldLabels: Record<string, string> = {
    allow_production: '允许生产',
    allow_shipment: '允许出货',
    payment_hold: '付款暂停',
  };

  await (supabase.from('order_logs') as any).insert({
    order_id: orderId,
    actor_id: user.id,
    action: 'business_override',
    field_name: field,
    old_value: String(!value),
    new_value: String(value),
    note: `[经营控制覆盖] ${fieldLabels[field]} → ${value ? '是' : '否'}。原因：${reason}`,
  });

  revalidatePath(`/orders/${orderId}`);
  return {};
}
