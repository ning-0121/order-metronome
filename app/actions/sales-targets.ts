'use server';

/**
 * 销售目标 Server Actions
 *
 * 权限：
 *  - 设置/删除：admin only
 *  - 查询：任意已登录用户，但 listMyTargets 会按"我负责的客户"过滤
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import {
  computeTargetProgress,
  getOrderRevenueCny,
  type TargetProgress,
} from '@/lib/services/sales-targets.service';

export interface CustomerTargetRow {
  target_id: string;
  customer_id: string;
  customer_name: string;
  year: number;
  target_amount_cny: number;
  notes: string | null;
  progress: TargetProgress;
  isMyCustomer: boolean;
}

// ─────────────────────────────────────────────────────────────
// 1. 设置 / 更新目标（upsert）
// ─────────────────────────────────────────────────────────────
export async function setCustomerTarget(
  customerId: string,
  year: number,
  amountCny: number,
  notes?: string,
): Promise<{ error?: string; data?: any }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可设置销售目标' };

  if (!customerId) return { error: '缺少客户 ID' };
  if (!year || year < 2020 || year > 2100) return { error: '年份不合法' };
  if (!amountCny || amountCny <= 0) return { error: '目标金额必须大于 0' };

  const { data, error } = await (supabase.from('customer_sales_targets') as any)
    .upsert(
      {
        customer_id: customerId,
        year,
        target_amount_cny: amountCny,
        notes: notes?.trim() || null,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'customer_id,year' },
    )
    .select()
    .single();

  if (error) return { error: error.message };

  revalidatePath('/sales-targets');
  revalidatePath('/ceo');
  return { data };
}

// ─────────────────────────────────────────────────────────────
// 2. 删除目标
// ─────────────────────────────────────────────────────────────
export async function deleteCustomerTarget(targetId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可删除销售目标' };

  const { error } = await (supabase.from('customer_sales_targets') as any)
    .delete()
    .eq('id', targetId);

  if (error) return { error: error.message };
  revalidatePath('/sales-targets');
  revalidatePath('/ceo');
  return {};
}

// ─────────────────────────────────────────────────────────────
// 3. 列出目标 + 进度
//    - admin/finance：看全部客户（含未设目标的，showMissing 开关控制）
//    - 其他角色：仅看自己负责过订单的客户
// ─────────────────────────────────────────────────────────────
export async function listTargets(
  year: number,
  options: { showAll?: boolean } = {},
): Promise<{ data?: CustomerTargetRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  const isFinance = userRoles.includes('finance');
  const canSeeAll = isAdmin || isFinance;

  // 当年所有订单（含 financials + 客户）
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, customer_id, customer_name, owner_user_id, created_by, quantity, lifecycle_status, created_at')
    .gte('created_at', yearStart)
    .lt('created_at', yearEnd)
    .not('lifecycle_status', 'in', '("cancelled","已取消")');

  const orderList = (orders || []) as any[];

  // 拉对应的 financials
  const orderIds = orderList.map(o => o.id);
  let financialsMap: Record<string, any> = {};
  if (orderIds.length > 0) {
    const { data: fins } = await (supabase.from('order_financials') as any)
      .select('order_id, sale_total, sale_price_per_piece, sale_currency, exchange_rate')
      .in('order_id', orderIds);
    for (const f of (fins || []) as any[]) {
      financialsMap[f.order_id] = f;
    }
  }

  // 按客户聚合销售额（CNY）+ 标记"我负责"
  const customerActual: Record<string, { cny: number; mine: boolean; name: string }> = {};
  for (const o of orderList) {
    if (!o.customer_id) continue;
    const fin = financialsMap[o.id];
    const cny = getOrderRevenueCny(fin, o.quantity);
    if (!customerActual[o.customer_id]) {
      customerActual[o.customer_id] = { cny: 0, mine: false, name: o.customer_name || '' };
    }
    customerActual[o.customer_id].cny += cny;
    if (o.owner_user_id === user.id || o.created_by === user.id) {
      customerActual[o.customer_id].mine = true;
    }
  }

  // 拉所有目标
  const { data: targets } = await (supabase.from('customer_sales_targets') as any)
    .select('id, customer_id, year, target_amount_cny, notes, customers!inner(id, customer_name)')
    .eq('year', year);

  const targetMap: Record<string, any> = {};
  for (const t of (targets || []) as any[]) {
    targetMap[t.customer_id] = t;
  }

  // 合并
  const customerIds = new Set<string>([
    ...Object.keys(customerActual),
    ...Object.keys(targetMap),
  ]);

  const result: CustomerTargetRow[] = [];
  for (const cid of customerIds) {
    const t = targetMap[cid];
    const actual = customerActual[cid];

    // 权限过滤：非 admin/finance → 只看自己负责的
    if (!canSeeAll && !(actual?.mine)) continue;

    // 没有目标 + showAll=false → 跳过
    if (!t && !options.showAll) continue;

    const targetCny = t ? Number(t.target_amount_cny) : 0;
    const actualCny = actual?.cny || 0;
    const customerName = t?.customers?.customer_name || actual?.name || '';

    if (!targetCny && !options.showAll) continue;

    result.push({
      target_id: t?.id || '',
      customer_id: cid,
      customer_name: customerName,
      year,
      target_amount_cny: targetCny,
      notes: t?.notes || null,
      progress: computeTargetProgress(targetCny, actualCny, year),
      isMyCustomer: !!actual?.mine,
    });
  }

  // 排序：落后程度由严重→正常
  const statusOrder: Record<string, number> = { behind: 0, slight_behind: 1, on_track: 2, ahead: 3 };
  result.sort((a, b) => {
    const sa = statusOrder[a.progress.evaluation.status] ?? 99;
    const sb = statusOrder[b.progress.evaluation.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return b.target_amount_cny - a.target_amount_cny;
  });

  return { data: result };
}

// ─────────────────────────────────────────────────────────────
// 4. 列出可设目标的客户（用于 admin 设目标的下拉选择）
// ─────────────────────────────────────────────────────────────
export async function listAllCustomersForTarget(): Promise<{
  data?: { id: string; customer_name: string }[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可访问' };

  const { data, error } = await (supabase.from('customers') as any)
    .select('id, customer_name')
    .order('customer_name');

  if (error) return { error: error.message };
  return { data: data || [] };
}
