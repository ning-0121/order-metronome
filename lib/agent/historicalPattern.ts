/**
 * 历史模式推理 — 从相似订单的成功/失败中学习
 *
 * 找出与当前订单相似的历史订单（同客户/同工厂/同数量级），
 * 分析它们的执行模式，给出预警和建议。
 */

export interface HistoricalInsight {
  similarOrderCount: number;
  avgCompletionDays: number;
  overdueRate: number;        // 历史超期率
  commonDelayNodes: string[]; // 历史最常超期的节点
  riskPrediction: string;     // 风险预测
  suggestion: string;         // 建议
}

export async function analyzeHistoricalPattern(
  supabase: any,
  customerName: string,
  factoryName: string | null,
  quantity: number | null,
): Promise<HistoricalInsight | null> {
  // 找相似的已完成订单（同客户或同工厂）
  let query = supabase
    .from('orders')
    .select('id, order_no, quantity, created_at, factory_date')
    .in('lifecycle_status', ['已完成', 'completed', '已复盘'])
    .limit(20);

  // 优先同客户同工厂
  if (factoryName) {
    query = query.or(`customer_name.eq.${customerName},factory_name.eq.${factoryName}`);
  } else {
    query = query.eq('customer_name', customerName);
  }

  const { data: similarOrders } = await query;
  if (!similarOrders || similarOrders.length < 2) return null;

  const orderIds = similarOrders.map((o: any) => o.id);

  // 获取这些订单的里程碑完成情况
  const { data: milestones } = await supabase
    .from('milestones')
    .select('order_id, name, step_key, status, due_at, completed_at')
    .in('order_id', orderIds);

  if (!milestones || milestones.length === 0) return null;

  // 统计超期节点
  const nodeOverdueCount: Record<string, number> = {};
  let totalNodes = 0;
  let overdueNodes = 0;
  const completionDays: number[] = [];

  for (const order of similarOrders) {
    const orderMs = milestones.filter((m: any) => m.order_id === order.id);
    const first = orderMs.find((m: any) => m.completed_at);
    const last = [...orderMs].filter((m: any) => m.completed_at)
      .sort((a: any, b: any) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0];

    if (first?.completed_at && last?.completed_at) {
      const days = Math.ceil((new Date(last.completed_at).getTime() - new Date(order.created_at).getTime()) / 86400000);
      if (days > 0 && days < 200) completionDays.push(days);
    }

    for (const m of orderMs) {
      if (m.completed_at && m.due_at) {
        totalNodes++;
        if (new Date(m.completed_at) > new Date(m.due_at)) {
          overdueNodes++;
          nodeOverdueCount[m.name] = (nodeOverdueCount[m.name] || 0) + 1;
        }
      }
    }
  }

  const avgDays = completionDays.length > 0
    ? Math.round(completionDays.reduce((s, d) => s + d, 0) / completionDays.length)
    : 0;
  const overdueRate = totalNodes > 0 ? Math.round((overdueNodes / totalNodes) * 100) : 0;
  const commonDelays = Object.entries(nodeOverdueCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  let riskPrediction = '';
  let suggestion = '';

  if (overdueRate > 40) {
    riskPrediction = `该客户/工厂历史超期率${overdueRate}%，高风险`;
    suggestion = `重点关注${commonDelays.join('、')}节点，历史最常超期。建议提前2天介入跟进。`;
  } else if (overdueRate > 20) {
    riskPrediction = `历史超期率${overdueRate}%，中等风险`;
    suggestion = `注意${commonDelays[0] || '生产'}环节，历史偶有延误。`;
  } else {
    riskPrediction = `历史超期率${overdueRate}%，风险较低`;
    suggestion = `该客户/工厂历史表现良好，按正常节奏推进。`;
  }

  return {
    similarOrderCount: similarOrders.length,
    avgCompletionDays: avgDays,
    overdueRate,
    commonDelayNodes: commonDelays,
    riskPrediction,
    suggestion,
  };
}
