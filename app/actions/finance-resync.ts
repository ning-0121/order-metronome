'use server';

/**
 * 手动重新同步订单主数据到外部财务系统
 *
 * SoT 边界（重要）：
 *   - 订单主数据（金额/币种/付款条款/客户/PO）SoT = order-metronome
 *   - 收款相关（应收/实收/核销/账龄）SoT = Finance System
 *
 * 本 action 只推送订单主数据。**不修改、不读取** order_financials 中的
 * deposit/balance 字段（那些是悬空字段，参见 docs/system-layer.md）。
 *
 * 用途：当 OM 端订单主数据被修改后，财务系统未及时反映时，由人工触发重新推送。
 *
 * 权限：admin / finance
 */

import { createClient } from '@/lib/supabase/server';
import { syncOrderToFinance } from '@/lib/integration/finance-sync';

export async function resyncOrderToFinance(
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();

  // 1. 鉴权
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '未登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();

  const roles: string[] =
    profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);

  if (!roles.some((r) => ['admin', 'finance'].includes(r))) {
    return { ok: false, error: '仅 admin / finance 可重新同步到财务系统' };
  }

  // 2. 读取订单主数据
  const { data: order, error: orderErr } = await (supabase.from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();

  if (orderErr || !order) {
    return { ok: false, error: orderErr?.message || '订单不存在' };
  }

  // 3. 推送到财务系统
  const result = await syncOrderToFinance(order, 'order.resync');

  // 4. 写审计日志（无论成功失败都写）
  await (supabase.from('order_logs') as any).insert({
    order_id: orderId,
    actor_id: user.id,
    action: 'finance_resync',
    field_name: null,
    old_value: null,
    new_value: result.success ? 'success' : 'failed',
    note: result.success
      ? '手动重新同步订单到财务系统'
      : `手动重新同步订单到财务系统（失败：${result.error || '未知错误'}）`,
  });

  if (!result.success) {
    return {
      ok: false,
      error: result.error || '推送失败，请稍后重试或联系管理员',
    };
  }

  return { ok: true };
}
