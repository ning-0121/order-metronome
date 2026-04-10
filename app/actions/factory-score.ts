'use server';

/**
 * 工厂评分 — 交期/质量/配合度三维打分
 *
 * 数据来源全自动（不需要人工评分）：
 *   交期分 = 已完成订单的工厂完成节点准时率
 *   质量分 = 中查/尾查逾期率的反面（越少逾期 = 质量管控越好）
 *   配合度 = 平均响应时间（从节点开始到完成的速度）
 */

import { createClient } from '@/lib/supabase/server';

export interface FactoryScore {
  factoryName: string;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  // 三维评分（0-100）
  deliveryScore: number;    // 交期：工厂完成节点准时率
  qualityScore: number;     // 质量：QC 节点准时率
  cooperationScore: number; // 配合度：平均响应速度
  overallScore: number;     // 综合 = 交期 40% + 质量 35% + 配合 25%
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  // 明细
  onTimeDeliveryRate: number;
  avgDeliveryDelay: number;
  qcOnTimeRate: number;
  avgResponseDays: number;
  // 在手
  currentLoad: number;
  customers: string[];
}

export async function getFactoryScores(): Promise<{
  data?: FactoryScore[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 获取所有有工厂名的订单
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, factory_name, customer_name, lifecycle_status')
    .not('factory_name', 'is', null);

  if (!orders) return { data: [] };

  // 按工厂分组
  const factoryOrders: Record<string, any[]> = {};
  for (const o of orders as any[]) {
    if (!o.factory_name) continue;
    if (!factoryOrders[o.factory_name]) factoryOrders[o.factory_name] = [];
    factoryOrders[o.factory_name].push(o);
  }

  const doneStatuses = new Set(['completed', '已完成', 'archived', '已归档']);
  const scores: FactoryScore[] = [];

  for (const [factoryName, fOrders] of Object.entries(factoryOrders)) {
    const totalOrders = fOrders.length;
    const completedOrders = fOrders.filter(o => doneStatuses.has(o.lifecycle_status)).length;
    const activeOrders = fOrders.filter(o => !doneStatuses.has(o.lifecycle_status) && o.lifecycle_status !== 'cancelled' && o.lifecycle_status !== '已取消').length;
    const customers = [...new Set(fOrders.map(o => o.customer_name).filter(Boolean))];

    if (totalOrders < 1) continue;

    const orderIds = fOrders.map(o => o.id);

    // 查 factory_completion + QC 节点
    const { data: milestones } = await (supabase.from('milestones') as any)
      .select('order_id, step_key, due_at, actual_at, status')
      .in('order_id', orderIds.slice(0, 30))
      .in('step_key', ['factory_completion', 'mid_qc_check', 'final_qc_check'])
      .in('status', ['done', '已完成']);

    const ms = (milestones || []) as any[];

    // 交期：factory_completion 准时率
    const deliveryMs = ms.filter(m => m.step_key === 'factory_completion' && m.due_at && m.actual_at);
    let deliveryOnTime = 0;
    let deliveryDelayTotal = 0;
    for (const m of deliveryMs) {
      const delay = (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000;
      if (delay <= 1) deliveryOnTime++; // 1 天以内算准时
      else deliveryDelayTotal += delay;
    }
    const onTimeDeliveryRate = deliveryMs.length > 0 ? Math.round((deliveryOnTime / deliveryMs.length) * 100) : 50;
    const avgDeliveryDelay = deliveryMs.length > 0 ? Number((deliveryDelayTotal / deliveryMs.length).toFixed(1)) : 0;
    const deliveryScore = Math.min(100, onTimeDeliveryRate);

    // 质量：QC 节点准时率
    const qcMs = ms.filter(m => ['mid_qc_check', 'final_qc_check'].includes(m.step_key) && m.due_at && m.actual_at);
    let qcOnTime = 0;
    for (const m of qcMs) {
      const delay = (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000;
      if (delay <= 1) qcOnTime++;
    }
    const qcOnTimeRate = qcMs.length > 0 ? Math.round((qcOnTime / qcMs.length) * 100) : 50;
    const qualityScore = Math.min(100, qcOnTimeRate);

    // 配合度：所有节点平均响应天数
    const allDoneMs = ms.filter(m => m.due_at && m.actual_at);
    let totalResponseDays = 0;
    for (const m of allDoneMs) {
      const resp = Math.max(0, (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000);
      totalResponseDays += resp;
    }
    const avgResponseDays = allDoneMs.length > 0 ? Number((totalResponseDays / allDoneMs.length).toFixed(1)) : 0;
    const cooperationScore = avgResponseDays <= 0.5 ? 100
      : avgResponseDays <= 1 ? 90
      : avgResponseDays <= 2 ? 75
      : avgResponseDays <= 3 ? 60
      : avgResponseDays <= 5 ? 40 : 20;

    // 综合
    const overallScore = completedOrders >= 2
      ? Math.round(deliveryScore * 0.4 + qualityScore * 0.35 + cooperationScore * 0.25)
      : 50; // 数据不足给默认中间值

    const grade: FactoryScore['grade'] =
      overallScore >= 90 ? 'S' :
      overallScore >= 75 ? 'A' :
      overallScore >= 60 ? 'B' :
      overallScore >= 40 ? 'C' : 'D';

    scores.push({
      factoryName,
      totalOrders,
      activeOrders,
      completedOrders,
      deliveryScore,
      qualityScore,
      cooperationScore,
      overallScore,
      grade,
      onTimeDeliveryRate,
      avgDeliveryDelay,
      qcOnTimeRate,
      avgResponseDays,
      currentLoad: activeOrders,
      customers,
    });
  }

  scores.sort((a, b) => b.overallScore - a.overallScore);
  return { data: scores };
}
