'use server';

import { createClient } from '@/lib/supabase/server';
import { calcDueDates } from '@/lib/schedule';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { isDoneStatus } from '@/lib/domain/types';
import { TERMINAL_LIFECYCLE_FILTER } from '@/lib/domain/lifecycleStatus';

/**
 * 重算单个订单所有未完成关卡的截止日期
 * 仅管理员可调用
 */
export async function recalcOrderMilestones(orderId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可重算排期' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, incoterm, etd, warehouse_due_date, order_date, created_at, factory_date, eta, skip_pre_production_sample, sample_confirm_days_override')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // RMB订单用出厂日期作为锚点，不需要ETD/ETA
  const scheduleIncoterm = order.incoterm === 'DDP' ? 'DDP' : 'FOB';
  const scheduleEtd = order.etd || order.factory_date;
  if (!scheduleEtd) return { error: '缺少锚点日期：请填写出厂日期' };

  let dueDates;
  try {
    dueDates = calcDueDates({
      orderDate: order.order_date,
      createdAt: new Date(order.created_at),
      incoterm: scheduleIncoterm as 'FOB' | 'DDP',
      etd: scheduleEtd,
      warehouseDueDate: order.warehouse_due_date,
      eta: order.eta,
      skipPreProductionSample: !!order.skip_pre_production_sample,
      sampleConfirmDaysOverride: order.sample_confirm_days_override ?? null,
    });
  } catch (e: any) {
    return { error: `排期计算失败：${e.message}` };
  }

  // 获取所有未完成的关卡
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, step_key, status')
    .eq('order_id', orderId);

  let updated = 0;
  for (const m of milestones || []) {
    const newDue = dueDates[m.step_key as keyof typeof dueDates];
    if (!newDue) continue;

    // 已完成的关卡不改时间
    if (isDoneStatus(m.status)) continue;

    await (supabase.from('milestones') as any)
      .update({
        due_at: newDue.toISOString(),
        planned_at: newDue.toISOString(),
      })
      .eq('id', m.id);
    updated++;
  }

  return { data: { order_no: order.order_no, updated } };
}

/**
 * 批量重算所有未完成订单的关卡时间
 */
export async function recalcAllOrders() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可重算排期' };

  // 获取所有未完成的订单
  // 注意：必须用 TERMINAL_LIFECYCLE_FILTER 同时排除中英文枚举
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no')
    .not('lifecycle_status', 'in', TERMINAL_LIFECYCLE_FILTER);

  const results = [];
  for (const order of orders || []) {
    const result = await recalcOrderMilestones(order.id);
    results.push({ order_no: order.order_no, ...result });
  }

  const successCount = results.filter(r => r.data).length;
  return {
    data: {
      total: (orders || []).length,
      success: successCount,
      results,
    },
  };
}
