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
import { writeAuditEvent } from '@/lib/audit/write-audit-event';
import { friendlyError } from '@/lib/utils/db-error';
import { revalidatePath } from 'next/cache';
import {
  computeOrderBusinessState,
  type OrderBusinessState,
  type EngineInput,
} from '@/lib/engine/orderBusinessEngine';
import { isCustomerShipHoldFromOrder } from '@/lib/domain/customerShipHold';
import { hasRoleInGroup } from '@/lib/domain/roles';

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
      .select('id, order_no, quantity, incoterm, factory_date, is_new_customer, is_new_factory, special_tags, lifecycle_status, notes')
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
      .select('step_key, status, due_at, name, sequence_number, owner_role')
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
    } catch (e: any) { console.warn(`[order-business-state] 业务状态覆盖审计写入:`, e?.message); }
  }

  const input: EngineInput = {
    order: {
      ...orderRes.data,
      is_new_customer: orderRes.data.is_new_customer ?? false,
      is_new_factory: orderRes.data.is_new_factory ?? false,
      special_tags: orderRes.data.special_tags || [],
      customer_ship_hold: isCustomerShipHoldFromOrder({
        special_tags: orderRes.data.special_tags,
        notes: orderRes.data.notes,
      }),
    },
    financials: financialsRes.data || null,
    confirmations: confirmationsRes.data || [],
    milestones: milestonesRes.data || [],
  };

  const state = computeOrderBusinessState(input);

  // 价格红线：非可见财务角色，后端抹掉利润字段（不能只靠前端隐藏 —— 直接调 action 也拿不到）
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  if (!hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS')) {
    state.margin_pct = null;
    state.gross_profit_rmb = null;
    state.order_profit_status = { value: 'unknown', level: 'gray', explain: '无权查看利润' } as typeof state.order_profit_status;
  }

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

  // 权限(2026-07-11 审计:按 Constitution 拆权限,不再硬编码 ['admin','finance'] 一刀切)——
  // 放货/投产闸(allow_shipment/allow_production)= 经营控制,CAN_OVERRIDE_BUSINESS_BLOCK 仅 admin
  //   (Constitution:避免越权放货);付款暂停(payment_hold)= 财务职权,CAN_APPROVE_PROC_FINANCE(admin/finance)。
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles, name, email').eq('user_id', user.id).single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  if (field === 'payment_hold') {
    if (!hasRoleInGroup(roles, 'CAN_APPROVE_PROC_FINANCE')) return { error: '仅财务/管理员可改付款暂停' };
  } else {
    if (!hasRoleInGroup(roles, 'CAN_OVERRIDE_BUSINESS_BLOCK')) return { error: '仅管理员可覆盖放货/投产闸(经营控制)' };
  }

  // 更新
  const { error } = await (supabase.from('order_financials') as any)
    .update({
      [field]: value,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId);

  if (error) return { error: friendlyError(error) };

  // 写审计日志到 order_logs
  const fieldLabels: Record<string, string> = {
    allow_production: '允许生产',
    allow_shipment: '允许出货',
    payment_hold: '付款暂停',
  };

  // R1-D:发货/生产放行闸的开关是**监管级证据**(出纠纷要答"谁放的货、为什么")→ A2。
  // 此前 session 裸插:order_logs 的 INSERT RLS=仅订单创建人,财务方园的放货审计
  // 全被静默拒收 —— 生产 0 条(体检实锤)。统一层 service-role 写 + 失败即告警。
  const arOv = await writeAuditEvent({
    eventType: 'business_override', level: 'A2', riskLevel: 'money',
    actor: { actorType: 'user', actorId: user.id },
    entity: { entityType: 'order', entityId: orderId, orderId },
    commandName: 'overrideBusinessControl',
    reason,
    beforeState: { [field]: !value }, afterState: { [field]: value },
    note: `[经营控制覆盖] ${fieldLabels[field]} → ${value ? '是' : '否'}。原因：${reason}`,
  });
  if (!arOv.ok) console.error('[business_override] A2 审计失败 → completed_unverified(admin 已告警)');

  // 放货 → 通知物流部安排出运/送仓(2026-07-13:补「财务发货通知→物流」这一环)
  if (field === 'allow_shipment' && value === true) {
    try {
      const { notifyUsersByRole } = await import('@/lib/utils/notifications');
      const { data: ord } = await (supabase.from('orders') as any)
        .select('order_no, internal_order_no, customer_name, delivery_type').eq('id', orderId).maybeSingle();
      const no = (ord as any)?.internal_order_no || (ord as any)?.order_no || '';
      const way = (ord as any)?.delivery_type === 'domestic' ? '国内送仓' : '出口出运';
      await notifyUsersByRole(supabase, ['logistics'], {
        type: 'shipment_released',
        title: `🚚 财务已放货:${no}`,
        message: `${(ord as any)?.customer_name || ''} · ${way} —— 财务已放货,请到「物流工作台」安排出运/送仓。`,
        relatedOrderId: orderId,
      });
    } catch { /* 通知失败不阻断放货 */ }

    // 审计 2026-08-20(P1-2):站内开闸后,财务系统审批队列里该单的未决出货审批会永远挂 pending
    // (财务以为没放行、货已经走了)。把未决行同步置 expired,两边状态不再错位。await 防冻结丢事件。
    try {
      const { createServiceRoleClient } = await import('@/lib/supabase/server');
      const { data: pendConfs } = await (createServiceRoleClient().from('shipment_confirmations') as any)
        .select('id').eq('order_id', orderId).eq('status', 'sales_signed');
      if (pendConfs && pendConfs.length > 0) {
        const { syncShipmentApprovalCancelledToFinance } = await import('@/lib/integration/finance-sync');
        for (const c of pendConfs as Array<{ id: string }>) {
          await syncShipmentApprovalCancelledToFinance({ id: c.id, reason: '站内管理员/财务直接放货,原出货审批申请作废' });
        }
      }
    } catch (e: any) { console.warn('[overrideBusinessControl] 财务队列过期同步失败(不阻断):', e?.message); }
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/logistics');
  return {};
}
