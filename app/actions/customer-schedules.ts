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
