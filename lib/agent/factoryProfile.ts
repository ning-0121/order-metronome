/**
 * 工厂产能画像 — Agent 建议时参考工厂实际负荷
 */

export interface FactoryProfile {
  factoryName: string;
  workerCount: number | null;
  monthlyCapacity: number | null;
  activeOrderCount: number;
  activeQuantity: number;
  utilizationRate: number;    // 产能利用率(%)
  historicalOnTimeRate: number;
  riskLevel: 'low' | 'medium' | 'high';
  tags: string[];
}

export async function buildFactoryProfile(
  supabase: any,
  factoryName: string,
): Promise<FactoryProfile> {
  const profile: FactoryProfile = {
    factoryName,
    workerCount: null, monthlyCapacity: null,
    activeOrderCount: 0, activeQuantity: 0,
    utilizationRate: 0, historicalOnTimeRate: 0,
    riskLevel: 'low', tags: [],
  };

  // 工厂基础数据
  const { data: factory } = await supabase
    .from('factories')
    .select('worker_count, monthly_capacity, product_categories')
    .eq('factory_name', factoryName)
    .is('deleted_at', null)
    .single();

  if (factory) {
    profile.workerCount = factory.worker_count;
    profile.monthlyCapacity = factory.monthly_capacity;
  }

  // 在手订单
  const { data: activeOrders } = await supabase
    .from('orders')
    .select('id, quantity')
    .eq('factory_name', factoryName)
    .not('lifecycle_status', 'in', '("已完成","completed","已取消","cancelled","已复盘")');

  profile.activeOrderCount = (activeOrders || []).length;
  profile.activeQuantity = (activeOrders || []).reduce((s: number, o: any) => s + (o.quantity || 0), 0);

  // 产能利用率
  if (profile.monthlyCapacity && profile.monthlyCapacity > 0) {
    profile.utilizationRate = Math.round((profile.activeQuantity / profile.monthlyCapacity) * 100);
    if (profile.utilizationRate > 120) profile.tags.push('超负荷');
    else if (profile.utilizationRate > 90) profile.tags.push('满负荷');
    else if (profile.utilizationRate < 30) profile.tags.push('产能空闲');
  }

  // 历史准时率
  const { data: completedOrders } = await supabase
    .from('orders')
    .select('id, factory_date')
    .eq('factory_name', factoryName)
    .in('lifecycle_status', ['已完成', 'completed', '已复盘']);

  if (completedOrders && completedOrders.length > 0) {
    const orderIds = completedOrders.map((o: any) => o.id);
    const { data: completions } = await supabase
      .from('milestones')
      .select('order_id, completed_at')
      .in('order_id', orderIds)
      .eq('step_key', 'factory_completion');

    let onTime = 0;
    for (const o of completedOrders) {
      const cm = completions?.find((c: any) => c.order_id === o.id);
      if (cm?.completed_at && o.factory_date) {
        if (new Date(cm.completed_at) <= new Date(o.factory_date + 'T23:59:59')) onTime++;
      }
    }
    profile.historicalOnTimeRate = Math.round((onTime / completedOrders.length) * 100);
    if (profile.historicalOnTimeRate < 60) profile.tags.push('交期不稳');
  }

  // 风险等级
  if (profile.utilizationRate > 120 || profile.historicalOnTimeRate < 50) profile.riskLevel = 'high';
  else if (profile.utilizationRate > 90 || profile.historicalOnTimeRate < 70) profile.riskLevel = 'medium';

  return profile;
}
