/**
 * 简易智能排单建议
 *
 * 基于工厂产能和订单分布，给出排单优化建议：
 * - 哪些工厂超负荷？建议分流
 * - 哪些月份空档？建议提前排单
 * - 客户交期冲突时如何调整优先级
 */

export interface SchedulingAdvice {
  factoryLoad: Array<{
    factory: string;
    activeQty: number;
    capacity: number;
    utilization: number;
    advice: string;
  }>;
  monthlyGaps: Array<{
    month: string;
    orderCount: number;
    totalQty: number;
    status: 'overload' | 'normal' | 'underload' | 'empty';
    advice: string;
  }>;
  priorityOrders: Array<{
    orderNo: string;
    customer: string;
    daysLeft: number;
    risk: string;
  }>;
  overallAdvice: string;
}

export async function generateSchedulingAdvice(supabase: any): Promise<SchedulingAdvice> {
  // 1. 工厂负荷分析
  const { data: factories } = await supabase
    .from('factories')
    .select('factory_name, monthly_capacity')
    .is('deleted_at', null);

  const { data: activeOrders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, factory_name, quantity, factory_date, lifecycle_status')
    .in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);

  const factoryQty: Record<string, number> = {};
  for (const o of activeOrders || []) {
    if (o.factory_name) {
      factoryQty[o.factory_name] = (factoryQty[o.factory_name] || 0) + (o.quantity || 0);
    }
  }

  const factoryLoad = (factories || [])
    .filter((f: any) => f.monthly_capacity && f.monthly_capacity > 0)
    .map((f: any) => {
      const activeQty = factoryQty[f.factory_name] || 0;
      const utilization = Math.round((activeQty / f.monthly_capacity) * 100);
      let advice = '';
      if (utilization > 120) advice = '超负荷！建议分流部分订单到其他工厂';
      else if (utilization > 90) advice = '接近满负荷，新单慎排';
      else if (utilization < 30) advice = '产能空闲，可接更多订单';
      else advice = '产能正常';
      return { factory: f.factory_name, activeQty, capacity: f.monthly_capacity, utilization, advice };
    })
    .sort((a: any, b: any) => b.utilization - a.utilization);

  // 2. 月度空档分析
  const now = new Date();
  const monthlyGaps = [];
  for (let i = 0; i <= 5; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthKey = d.toISOString().slice(0, 7);
    const monthLabel = `${d.getMonth() + 1}月`;
    const monthOrders = (activeOrders || []).filter((o: any) => (o.factory_date || '').startsWith(monthKey));
    const totalQty = monthOrders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
    const avgMonthlyQty = (activeOrders || []).reduce((s: number, o: any) => s + (o.quantity || 0), 0) / 6;

    let status: 'overload' | 'normal' | 'underload' | 'empty' = 'normal';
    let advice = '';
    if (totalQty === 0) { status = 'empty'; advice = '无订单，建议加大业务开发'; }
    else if (totalQty > avgMonthlyQty * 1.5) { status = 'overload'; advice = '订单集中，注意交期风险'; }
    else if (totalQty < avgMonthlyQty * 0.5) { status = 'underload'; advice = '订单偏少，可主动联系客户排单'; }
    else { advice = '正常'; }

    monthlyGaps.push({ month: monthLabel, orderCount: monthOrders.length, totalQty, status, advice });
  }

  // 3. 紧急订单优先级
  const priorityOrders = (activeOrders || [])
    .filter((o: any) => o.factory_date)
    .map((o: any) => {
      const daysLeft = Math.ceil((new Date(o.factory_date).getTime() - Date.now()) / 86400000);
      let risk = '';
      if (daysLeft < 0) risk = `已超期${Math.abs(daysLeft)}天`;
      else if (daysLeft <= 7) risk = '紧急';
      else if (daysLeft <= 14) risk = '需关注';
      else risk = '正常';
      return { orderNo: o.order_no, customer: o.customer_name, daysLeft, risk };
    })
    .filter((o: any) => o.daysLeft <= 14)
    .sort((a: any, b: any) => a.daysLeft - b.daysLeft)
    .slice(0, 10);

  // 4. 总体建议
  const overloadFactories = factoryLoad.filter((f: any) => f.utilization > 100);
  const emptyMonths = monthlyGaps.filter((m: any) => m.status === 'empty');
  const urgentOrders = priorityOrders.filter((o: any) => o.daysLeft <= 7);

  let overallAdvice = '';
  if (overloadFactories.length > 0) overallAdvice += `${overloadFactories.length}家工厂超负荷，需要分流。`;
  if (emptyMonths.length > 0) overallAdvice += `${emptyMonths.map(m => m.month).join('、')}无订单，建议提前开发。`;
  if (urgentOrders.length > 0) overallAdvice += `${urgentOrders.length}个订单7天内到期，需优先处理。`;
  if (!overallAdvice) overallAdvice = '当前排单状况正常，各工厂负荷均衡。';

  return { factoryLoad, monthlyGaps, priorityOrders, overallAdvice };
}
