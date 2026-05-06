'use server';

/**
 * 业务员个人面板 — 看自己负责客户的销售数据
 *
 * "我负责的" 定义：orders.owner_user_id = me OR orders.created_by = me
 */

import { createClient } from '@/lib/supabase/server';
import {
  computeTargetProgress,
  getCurrentLunarYear,
  getLunarYearRange,
  type TargetProgress,
} from '@/lib/services/sales-targets.service';

export interface MyCustomerStats {
  customer_id: string;
  customer_name: string;
  totalOrdersThisYear: number;
  actualQty: number;
  targetQty: number;
  hasTarget: boolean;
  progress: TargetProgress;
}

export interface MyDashboardData {
  year: number;
  yearStart: string;
  yearEnd: string;
  // 顶部 4 卡
  customerCount: number;
  totalOrdersThisYear: number;
  totalActualQty: number;
  totalTargetQty: number;
  overallProgressPct: number; // 0-100
  // 趋势
  thisWeekOrders: number;
  lastWeekOrders: number;
  weekGrowthPct: number;
  thisMonthOrders: number;
  lastMonthOrders: number;
  monthGrowthPct: number;
  // 客户列表
  customers: MyCustomerStats[];
}

export async function getMyDashboard(): Promise<{ data?: MyDashboardData; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const year = getCurrentLunarYear();
  const { startStr, endStr } = getLunarYearRange(year);

  // 拉"我负责的"年度订单（owner_user_id = 我 OR created_by = 我）
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, customer_id, customer_name, owner_user_id, created_by, quantity, lifecycle_status, created_at')
    .or(`owner_user_id.eq.${user.id},created_by.eq.${user.id}`)
    .gte('created_at', startStr)
    .lt('created_at', endStr)
    .not('lifecycle_status', 'in', '("cancelled","已取消")');

  const orderList = (orders || []) as any[];

  // 按客户聚合
  const customerMap: Record<string, { name: string; qty: number; count: number }> = {};
  for (const o of orderList) {
    if (!o.customer_id) continue;
    if (!customerMap[o.customer_id]) {
      customerMap[o.customer_id] = { name: o.customer_name || '', qty: 0, count: 0 };
    }
    customerMap[o.customer_id].qty += Number(o.quantity) || 0;
    customerMap[o.customer_id].count += 1;
  }

  // 拉这些客户的目标
  const customerIds = Object.keys(customerMap);
  let targetMap: Record<string, number> = {};
  if (customerIds.length > 0) {
    const { data: targets } = await (supabase.from('customer_sales_targets') as any)
      .select('customer_id, target_qty')
      .eq('year', year)
      .in('customer_id', customerIds);
    for (const t of (targets || []) as any[]) {
      targetMap[t.customer_id] = Number(t.target_qty);
    }
  }

  // 组合 customer 列表
  const customers: MyCustomerStats[] = customerIds.map(cid => {
    const c = customerMap[cid];
    const targetQty = targetMap[cid] || 0;
    return {
      customer_id: cid,
      customer_name: c.name,
      totalOrdersThisYear: c.count,
      actualQty: c.qty,
      targetQty,
      hasTarget: targetQty > 0,
      progress: computeTargetProgress(targetQty, c.qty, year),
    };
  });

  // 排序：有目标的优先（落后程度优先），无目标的按下单量
  const statusOrder: Record<string, number> = { behind: 0, slight_behind: 1, on_track: 2, ahead: 3 };
  customers.sort((a, b) => {
    if (a.hasTarget && !b.hasTarget) return -1;
    if (!a.hasTarget && b.hasTarget) return 1;
    if (a.hasTarget && b.hasTarget) {
      const sa = statusOrder[a.progress.evaluation.status] ?? 99;
      const sb = statusOrder[b.progress.evaluation.status] ?? 99;
      if (sa !== sb) return sa - sb;
    }
    return b.actualQty - a.actualQty;
  });

  const totalActualQty = customers.reduce((s, c) => s + c.actualQty, 0);
  const totalTargetQty = customers.reduce((s, c) => s + c.targetQty, 0);
  const overallProgressPct = totalTargetQty > 0 ? (totalActualQty / totalTargetQty) * 100 : 0;

  // ─── 本周 / 本月 / 趋势 ───
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - dow);
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = monthStart;

  const inRange = (d: Date, s: Date, e: Date) => d >= s && d < e;
  const thisWeekOrders   = orderList.filter(o => o.created_at && new Date(o.created_at) >= weekStart).length;
  const lastWeekOrders   = orderList.filter(o => o.created_at && inRange(new Date(o.created_at), lastWeekStart, weekStart)).length;
  const thisMonthOrders  = orderList.filter(o => o.created_at && new Date(o.created_at) >= monthStart).length;
  const lastMonthOrders  = orderList.filter(o => o.created_at && inRange(new Date(o.created_at), lastMonthStart, lastMonthEnd)).length;

  const weekGrowthPct = lastWeekOrders > 0
    ? Math.round(((thisWeekOrders - lastWeekOrders) / lastWeekOrders) * 100)
    : (thisWeekOrders > 0 ? 100 : 0);
  const monthGrowthPct = lastMonthOrders > 0
    ? Math.round(((thisMonthOrders - lastMonthOrders) / lastMonthOrders) * 100)
    : (thisMonthOrders > 0 ? 100 : 0);

  return {
    data: {
      year,
      yearStart: startStr,
      yearEnd: endStr,
      customerCount: customers.length,
      totalOrdersThisYear: orderList.length,
      totalActualQty,
      totalTargetQty,
      overallProgressPct,
      thisWeekOrders,
      lastWeekOrders,
      weekGrowthPct,
      thisMonthOrders,
      lastMonthOrders,
      monthGrowthPct,
      customers,
    },
  };
}
