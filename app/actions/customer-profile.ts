'use server';

/**
 * 客户画像 — 历史汇总 + 行为分析
 */

import { createClient } from '@/lib/supabase/server';

export interface CustomerProfile {
  name: string;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  totalQuantity: number;
  totalRevenue: number; // FOB/DDP 报价 × 数量 的累计（概算）
  avgOrderSize: number;
  // 交付表现
  onTimeRate: number;       // 准时交付率
  avgDelayDays: number;     // 平均延期天数
  // 付款习惯
  orderTypes: Record<string, number>; // bulk/repeat/trial 分布
  incoterms: Record<string, number>;  // FOB/DDP/RMB 分布
  // 时间线
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  daysSinceLastOrder: number;
  // 工厂分布
  factories: Array<{ name: string; count: number }>;
  // 风险信号
  riskSignals: string[];
}

export async function getCustomerProfile(customerName: string): Promise<{
  data?: CustomerProfile;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 所有订单
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, quantity, incoterm, order_type, lifecycle_status, created_at, factory_name, factory_date, etd')
    .eq('customer_name', customerName)
    .order('created_at', { ascending: false });

  if (!orders || orders.length === 0) {
    return { data: { name: customerName, totalOrders: 0, activeOrders: 0, completedOrders: 0, totalQuantity: 0, totalRevenue: 0, avgOrderSize: 0, onTimeRate: 0, avgDelayDays: 0, orderTypes: {}, incoterms: {}, firstOrderDate: null, lastOrderDate: null, daysSinceLastOrder: 0, factories: [], riskSignals: [] } };
  }

  const orderList = orders as any[];
  const totalOrders = orderList.length;
  const doneStatuses = new Set(['completed', '已完成', 'archived', '已归档']);
  const completedOrders = orderList.filter(o => doneStatuses.has(o.lifecycle_status)).length;
  const cancelledStatuses = new Set(['cancelled', '已取消']);
  const activeOrders = orderList.filter(o => !doneStatuses.has(o.lifecycle_status) && !cancelledStatuses.has(o.lifecycle_status)).length;
  const totalQuantity = orderList.reduce((s, o) => s + (o.quantity || 0), 0);
  const avgOrderSize = totalOrders > 0 ? Math.round(totalQuantity / totalOrders) : 0;

  // 类型/条款分布
  const orderTypes: Record<string, number> = {};
  const incoterms: Record<string, number> = {};
  for (const o of orderList) {
    orderTypes[o.order_type || 'bulk'] = (orderTypes[o.order_type || 'bulk'] || 0) + 1;
    incoterms[o.incoterm || 'FOB'] = (incoterms[o.incoterm || 'FOB'] || 0) + 1;
  }

  // 时间线
  const firstOrderDate = orderList[orderList.length - 1]?.created_at?.slice(0, 10) || null;
  const lastOrderDate = orderList[0]?.created_at?.slice(0, 10) || null;
  const daysSinceLastOrder = lastOrderDate
    ? Math.ceil((Date.now() - new Date(lastOrderDate).getTime()) / 86400000)
    : 0;

  // 工厂分布
  const factoryMap: Record<string, number> = {};
  for (const o of orderList) {
    if (o.factory_name) factoryMap[o.factory_name] = (factoryMap[o.factory_name] || 0) + 1;
  }
  const factories = Object.entries(factoryMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // 交付表现（查已完成订单的里程碑）
  const completedIds = orderList
    .filter(o => doneStatuses.has(o.lifecycle_status))
    .map(o => o.id);

  let onTimeRate = 0;
  let avgDelayDays = 0;

  if (completedIds.length > 0) {
    const { data: ms } = await (supabase.from('milestones') as any)
      .select('order_id, due_at, actual_at, status')
      .in('order_id', completedIds.slice(0, 20))
      .in('status', ['done', '已完成'])
      .not('actual_at', 'is', null)
      .not('due_at', 'is', null);

    let onTime = 0;
    let totalDelay = 0;
    let count = 0;
    for (const m of (ms || []) as any[]) {
      count++;
      const delay = (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000;
      if (delay <= 0) onTime++;
      else totalDelay += delay;
    }
    onTimeRate = count > 0 ? Math.round((onTime / count) * 100) : 0;
    avgDelayDays = count > 0 ? Number((totalDelay / count).toFixed(1)) : 0;
  }

  // 风险信号
  const riskSignals: string[] = [];
  if (daysSinceLastOrder > 90) riskSignals.push(`⚠ 超过 ${daysSinceLastOrder} 天没有新订单`);
  if (onTimeRate < 70 && completedOrders >= 3) riskSignals.push(`🔴 准时率仅 ${onTimeRate}%`);
  if (avgDelayDays > 3 && completedOrders >= 3) riskSignals.push(`🟡 平均延期 ${avgDelayDays} 天`);
  if (activeOrders > 5) riskSignals.push(`📦 同时在手 ${activeOrders} 个订单`);

  // 概算收入（简单用 quantity × $3 average per piece 估算）
  const totalRevenue = Math.round(totalQuantity * 3); // 粗略估算

  return {
    data: {
      name: customerName,
      totalOrders,
      activeOrders,
      completedOrders,
      totalQuantity,
      totalRevenue,
      avgOrderSize,
      onTimeRate,
      avgDelayDays,
      orderTypes,
      incoterms,
      firstOrderDate,
      lastOrderDate,
      daysSinceLastOrder,
      factories,
      riskSignals,
    },
  };
}
