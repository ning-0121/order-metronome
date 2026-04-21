'use server';

/**
 * 客户节奏偏好管理
 *
 * 每个客户可配置自定义排期规则（如 RAG 要求离厂前 1 天寄船样）
 * 规则优先级高于通用 TIMELINE 模板
 *
 * 操作权限：admin / sales / merchandiser
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { getCurrentUserRole, getUserRoles } from '@/lib/utils/user-role';

export interface CustomerWithOverrides {
  id: string;
  customer_name: string;
  customer_code: string | null;
  country: string | null;
  schedule_overrides: Record<string, { anchor: string; offset_days: number; note?: string }>;
  overrides_count: number; // 计算得来
}

/** 获取所有客户 + 各自的节奏偏好 */
export async function getCustomerSchedules(): Promise<{
  data?: CustomerWithOverrides[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  const roles = await getUserRoles(supabase, user.id);
  const canRead = isAdmin || roles.some(r => ['sales', 'merchandiser'].includes(r));
  if (!canRead) return { error: '无权限查看' };

  const { data, error } = await (supabase.from('customers') as any)
    .select('id, customer_name, customer_code, country, schedule_overrides')
    .is('deleted_at', null)
    .order('customer_name', { ascending: true });

  if (error) return { error: error.message };

  const rows: CustomerWithOverrides[] = (data || []).map((c: any) => ({
    id: c.id,
    customer_name: c.customer_name,
    customer_code: c.customer_code,
    country: c.country,
    schedule_overrides: c.schedule_overrides || {},
    overrides_count: Object.keys(c.schedule_overrides || {}).length,
  }));

  return { data: rows };
}

/** 保存单个客户的节奏偏好（整体替换） */
export async function updateCustomerScheduleOverrides(
  customerId: string,
  overrides: Record<string, { anchor: 'factory_date' | 'order_date' | 'eta'; offset_days: number; note?: string }>,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  const roles = await getUserRoles(supabase, user.id);
  const canEdit = isAdmin || roles.some(r => ['sales', 'merchandiser'].includes(r));
  if (!canEdit) return { error: '仅管理员/业务/跟单可编辑节奏偏好' };

  // 校验：anchor 合法 + offset_days 数字 + 范围
  const VALID_ANCHORS = ['factory_date', 'order_date', 'eta'];
  for (const [stepKey, rule] of Object.entries(overrides)) {
    if (!stepKey || typeof stepKey !== 'string') return { error: '无效的 step_key' };
    if (!VALID_ANCHORS.includes(rule.anchor)) return { error: `${stepKey}: 锚点必须是 factory_date/order_date/eta` };
    if (!Number.isFinite(rule.offset_days)) return { error: `${stepKey}: 偏移天数必须是数字` };
    if (Math.abs(rule.offset_days) > 120) return { error: `${stepKey}: 偏移天数应在 ±120 天内` };
  }

  const { error } = await (supabase.from('customers') as any)
    .update({ schedule_overrides: overrides, updated_at: new Date().toISOString() })
    .eq('id', customerId);
  if (error) return { error: error.message };

  revalidatePath('/admin/customer-schedules');
  return {};
}

/** 批量重算指定客户所有进行中订单的未完成里程碑排期 */
export async function batchRecalcCustomerMilestones(
  customerName: string,
): Promise<{ updated: number; skipped: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { updated: 0, skipped: 0, error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { updated: 0, skipped: 0, error: '仅管理员可批量重算排期' };

  // 1. 取客户节奏偏好
  const { data: customer } = await (supabase.from('customers') as any)
    .select('schedule_overrides')
    .eq('customer_name', customerName)
    .is('deleted_at', null)
    .maybeSingle();
  const overrides: Record<string, { anchor: 'factory_date' | 'order_date' | 'eta'; offset_days: number; note?: string }>
    = (customer as any)?.schedule_overrides || {};
  if (Object.keys(overrides).length === 0) {
    return { updated: 0, skipped: 0, error: `客户「${customerName}」尚未配置任何节奏偏好` };
  }

  // 2. 取该客户所有进行中的大货订单
  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('id, order_date, created_at, incoterm, etd, warehouse_due_date, eta, shipping_sample_required, shipping_sample_deadline, skip_pre_production_sample, sample_confirm_days_override, lifecycle_status')
    .eq('customer_name', customerName)
    .in('lifecycle_status', ['active', 'in_progress', 'draft'])
    .eq('order_type', 'bulk');
  if (oErr) return { updated: 0, skipped: 0, error: oErr.message };
  if (!orders || orders.length === 0) return { updated: 0, skipped: 0, error: `未找到「${customerName}」的进行中订单` };

  const { calcDueDates } = await import('@/lib/schedule');

  let updated = 0;
  let skipped = 0;

  for (const order of orders as any[]) {
    try {
      const dueDates = calcDueDates({
        orderDate: order.order_date,
        createdAt: new Date(order.created_at),
        incoterm: order.incoterm,
        etd: order.etd,
        warehouseDueDate: order.warehouse_due_date,
        eta: order.eta,
        shippingSampleRequired: order.shipping_sample_required ?? false,
        shippingSampleDeadline: order.shipping_sample_deadline,
        skipPreProductionSample: order.skip_pre_production_sample ?? false,
        sampleConfirmDaysOverride: order.sample_confirm_days_override ?? undefined,
        customerScheduleOverrides: overrides,
      });

      // 只更新覆盖规则涉及的 step_key、且该里程碑尚未完成
      for (const stepKey of Object.keys(overrides)) {
        const newDueAt = (dueDates as any)[stepKey];
        if (!newDueAt) continue;

        const { error: uErr } = await supabase
          .from('milestones')
          .update({ due_at: newDueAt.toISOString(), planned_at: newDueAt.toISOString() })
          .eq('order_id', order.id)
          .eq('step_key', stepKey)
          .is('actual_at', null); // 未完成的
        if (uErr) { skipped++; continue; }
        updated++;
      }
    } catch {
      skipped++;
    }
  }

  revalidatePath('/admin/customer-schedules');
  return { updated, skipped };
}

/** 根据客户名查询节奏偏好（供 orders.ts 创建订单时使用）*/
export async function getOverridesForCustomer(
  customerName: string | null,
): Promise<Record<string, { anchor: 'factory_date' | 'order_date' | 'eta'; offset_days: number; note?: string }>> {
  if (!customerName) return {};
  const supabase = await createClient();
  const { data } = await (supabase.from('customers') as any)
    .select('schedule_overrides')
    .eq('customer_name', customerName)
    .is('deleted_at', null)
    .maybeSingle();
  return (data as any)?.schedule_overrides || {};
}
