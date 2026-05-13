/**
 * 客户画像引擎 — 从历史数据自动生成客户行为模式
 *
 * 用于 Agent 建议的精准化：
 * - 客户平均确认产前样需要几天？→ 不要过早催办
 * - 客户历史延期率多少？→ 高延期客户提前预警
 * - 客户订单规模？→ 大客户优先处理
 * - 客户付款习惯？→ 影响出货审批建议
 *
 * V1.2 更新：
 * - avgPaymentDays 改为从 order_financials 真实数据计算
 * - 新增付款行为标签：'准时付款' / '付款拖延' / '尾款难收'
 */

export interface CustomerProfile {
  customerName: string;
  // 基础指标
  totalOrders: number;
  totalQuantity: number;
  avgOrderQuantity: number;
  // 时间行为
  avgSampleConfirmDays: number;   // 产前样平均确认天数（从寄出到确认）
  avgPaymentDays: number;         // 平均尾款到账天数（从出货到收款）
  // 风险指标
  delayRate: number;              // 延期申请率(%)
  overdueRate: number;            // 超期率(%)
  // 分类
  riskLevel: 'low' | 'medium' | 'high';
  tags: string[];                 // 如：'慢确认', '大客户', '新客户', '准时付款', '付款拖延'
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
    .select('order_id, step_key, actual_at')
    .in('order_id', orderIds)
    .in('step_key', ['pre_production_sample_sent', 'pre_production_sample_approved'])
    .not('actual_at', 'is', null);

  if (sampleMilestones && sampleMilestones.length > 0) {
    const sentMap = new Map<string, string>();
    const approvedMap = new Map<string, string>();
    for (const m of sampleMilestones) {
      if (m.step_key === 'pre_production_sample_sent') sentMap.set(m.order_id, m.actual_at);
      if (m.step_key === 'pre_production_sample_approved') approvedMap.set(m.order_id, m.actual_at);
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
    .select('due_at, actual_at')
    .in('order_id', orderIds)
    .not('actual_at', 'is', null);

  let overdueCount = 0;
  let completedCount = 0;
  for (const m of allMilestones || []) {
    if (m.due_at && m.actual_at) {
      completedCount++;
      if (new Date(m.actual_at) > new Date(m.due_at)) overdueCount++;
    }
  }
  profile.overdueRate = completedCount > 0 ? Math.round((overdueCount / completedCount) * 100) : 0;

  // ── 付款行为：从 order_financials + 出货里程碑反算实际付款天数 ──
  // TODO(SoT): payment collection status is owned by Finance System.
  // These order_financials fields are legacy/cache signals only and must not be
  // treated as the source of truth. Customer payment behavior should ultimately
  // be computed from Finance System data (currently unavailable via API).
  // See docs/system-layer.md.
  try {
    const { data: financials } = await supabase
      .from('order_financials')
      .select('order_id, balance_status, balance_received_at, balance_due_date')
      .in('order_id', orderIds)
      .eq('balance_status', 'received')
      .not('balance_received_at', 'is', null);

    if (financials && financials.length >= 2) {
      // 用收款日 - 账期截止日 计算超/准时情况
      const paymentDelays: number[] = [];
      for (const fin of financials) {
        if (fin.balance_received_at && fin.balance_due_date) {
          const d = Math.ceil(
            (new Date(fin.balance_received_at).getTime() - new Date(fin.balance_due_date).getTime()) / 86400000
          );
          paymentDelays.push(d); // 正值 = 逾期天数，负值 = 提前
        }
      }
      if (paymentDelays.length >= 2) {
        const avgDelay = paymentDelays.reduce((a, b) => a + b, 0) / paymentDelays.length;
        profile.avgPaymentDays = Math.round(avgDelay); // 相对账期的偏移天数
        if (avgDelay > 15) {
          profile.tags.push('尾款难收');
        } else if (avgDelay > 5) {
          profile.tags.push('付款拖延');
        } else if (avgDelay <= 0) {
          profile.tags.push('准时付款');
        }
      }
    } else {
      // 数据不足：检查是否有逾期状态
      const { count: overduePayCount } = await supabase
        .from('order_financials')
        .select('id', { count: 'exact', head: true })
        .in('order_id', orderIds)
        .eq('balance_status', 'overdue');
      if ((overduePayCount || 0) > 0) {
        profile.tags.push('尾款难收');
      }
    }
  } catch {}

  // 风险等级（综合延期率 + 超期率 + 付款行为）
  const hasPaymentRisk = profile.tags.includes('尾款难收') || profile.tags.includes('付款拖延');
  if (profile.delayRate > 40 || profile.overdueRate > 30 || profile.tags.includes('尾款难收')) {
    profile.riskLevel = 'high';
  } else if (profile.delayRate > 20 || profile.overdueRate > 15 || hasPaymentRisk) {
    profile.riskLevel = 'medium';
  } else {
    profile.riskLevel = 'low';
  }

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
