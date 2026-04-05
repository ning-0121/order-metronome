/**
 * 客户画像引擎 — 从历史数据自动生成客户行为模式
 *
 * 用于 Agent 建议的精准化：
 * - 客户平均确认产前样需要几天？→ 不要过早催办
 * - 客户历史延期率多少？→ 高延期客户提前预警
 * - 客户订单规模？→ 大客户优先处理
 * - 客户付款习惯？→ 影响出货审批建议
 */

export interface CustomerProfile {
  customerName: string;
  // 基础指标
  totalOrders: number;
  totalQuantity: number;
  avgOrderQuantity: number;
  // 时间行为
  avgSampleConfirmDays: number;   // 产前样平均确认天数
  avgPaymentDays: number;         // 平均付款天数
  // 风险指标
  delayRate: number;              // 延期申请率(%)
  overdueRate: number;            // 超期率(%)
  // 分类
  riskLevel: 'low' | 'medium' | 'high';
  tags: string[];                 // 如：'慢确认', '大客户', '新客户', '准时付款'
}

/**
 * 从数据库计算客户画像
 */
export async function buildCustomerProfile(
  supabase: any,
  customerName: string,
): Promise<CustomerProfile> {
  const profile: CustomerProfile = {
    customerName,
    totalOrders: 0, totalQuantity: 0, avgOrderQuantity: 0,
    avgSampleConfirmDays: 7, avgPaymentDays: 30,
    delayRate: 0, overdueRate: 0,
    riskLevel: 'low', tags: [],
  };

  // 获取该客户所有订单
  const { data: orders } = await supabase
    .from('orders')
    .select('id, quantity, lifecycle_status, created_at')
    .eq('customer_name', customerName)
    .not('lifecycle_status', 'eq', '已取消');

  if (!orders || orders.length === 0) {
    profile.tags.push('新客户');
    profile.riskLevel = 'medium';
    return profile;
  }

  profile.totalOrders = orders.length;
  profile.totalQuantity = orders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
  profile.avgOrderQuantity = Math.round(profile.totalQuantity / profile.totalOrders);

  if (profile.totalQuantity > 100000) profile.tags.push('大客户');
  if (profile.totalOrders >= 10) profile.tags.push('老客户');
  if (profile.totalOrders <= 2) profile.tags.push('新客户');

  const orderIds = orders.map((o: any) => o.id);

  // 产前样确认时间（从寄出到确认的天数）
  const { data: sampleMilestones } = await supabase
    .from('milestones')
    .select('order_id, step_key, completed_at')
    .in('order_id', orderIds)
    .in('step_key', ['pre_production_sample_sent', 'pre_production_sample_approved'])
    .not('completed_at', 'is', null);

  if (sampleMilestones && sampleMilestones.length > 0) {
    const sentMap = new Map<string, string>();
    const approvedMap = new Map<string, string>();
    for (const m of sampleMilestones) {
      if (m.step_key === 'pre_production_sample_sent') sentMap.set(m.order_id, m.completed_at);
      if (m.step_key === 'pre_production_sample_approved') approvedMap.set(m.order_id, m.completed_at);
    }
    const confirmDays: number[] = [];
    for (const [orderId, sentAt] of sentMap) {
      const approvedAt = approvedMap.get(orderId);
      if (approvedAt) {
        const days = Math.ceil((new Date(approvedAt).getTime() - new Date(sentAt).getTime()) / 86400000);
        if (days > 0 && days < 60) confirmDays.push(days);
      }
    }
    if (confirmDays.length > 0) {
      profile.avgSampleConfirmDays = Math.round(confirmDays.reduce((s, d) => s + d, 0) / confirmDays.length);
      if (profile.avgSampleConfirmDays > 10) profile.tags.push('慢确认');
    }
  }

  // 延期率
  const { count: delayCount } = await supabase
    .from('delay_requests')
    .select('id', { count: 'exact', head: true })
    .in('order_id', orderIds);
  profile.delayRate = profile.totalOrders > 0 ? Math.round(((delayCount || 0) / profile.totalOrders) * 100) : 0;
  if (profile.delayRate > 50) profile.tags.push('高延期');

  // 超期率
  const { data: allMilestones } = await supabase
    .from('milestones')
    .select('due_at, completed_at')
    .in('order_id', orderIds)
    .not('completed_at', 'is', null);

  let overdueCount = 0;
  let completedCount = 0;
  for (const m of allMilestones || []) {
    if (m.due_at && m.completed_at) {
      completedCount++;
      if (new Date(m.completed_at) > new Date(m.due_at)) overdueCount++;
    }
  }
  profile.overdueRate = completedCount > 0 ? Math.round((overdueCount / completedCount) * 100) : 0;

  // 风险等级
  if (profile.delayRate > 40 || profile.overdueRate > 30) profile.riskLevel = 'high';
  else if (profile.delayRate > 20 || profile.overdueRate > 15) profile.riskLevel = 'medium';
  else profile.riskLevel = 'low';

  return profile;
}

/**
 * 根据客户画像调整催办阈值
 * 返回：应该超期几天才催办（默认2天）
 */
export function getNudgeThreshold(profile: CustomerProfile | null): number {
  if (!profile) return 2;
  // 慢确认客户：产前样相关节点放宽到5天
  if (profile.avgSampleConfirmDays > 10) return 4;
  // 老客户+低风险：放宽到3天
  if (profile.tags.includes('老客户') && profile.riskLevel === 'low') return 3;
  // 新客户+大订单：严格1天
  if (profile.tags.includes('新客户') && profile.avgOrderQuantity > 10000) return 1;
  return 2;
}
