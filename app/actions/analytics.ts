'use server';

import { createClient } from '@/lib/supabase/server';
import { getRoleLabel } from '@/lib/utils/i18n';
import { isDoneStatus, isActiveStatus, isBlockedStatus } from '@/lib/domain/types';

const _isDone = (s: string) => isDoneStatus(s);
const _isActive = (s: string) => isActiveStatus(s);

// 阶段映射
const PHASE_MAP: Record<string, string> = {
  po_confirmed: '阶段1：订单启动',
  finance_approval: '阶段1：订单启动',
  order_kickoff_meeting: '阶段1：订单启动',
  production_order_upload: '阶段1：订单启动',
  production_resources_confirmed: '阶段1：订单启动',
  order_docs_bom_complete: '阶段2：订单转化',
  bulk_materials_confirmed: '阶段2：订单转化',
  pre_production_sample_ready: '阶段3：产前样',
  pre_production_sample_sent: '阶段3：产前样',
  pre_production_sample_approved: '阶段3：产前样',
  procurement_order_placed: '阶段4：采购与生产',
  materials_received_inspected: '阶段4：采购与生产',
  production_kickoff: '阶段4：采购与生产',
  pre_production_meeting: '阶段4：采购与生产',
  mid_qc_check: '阶段5：过程控制',
  final_qc_check: '阶段5：过程控制',
  packing_method_confirmed: '阶段6：出货控制',
  factory_completion: '阶段6：出货控制',
  inspection_release: '阶段6：出货控制',
  shipping_sample_send: '阶段6：出货控制',
  booking_done: '阶段7：物流收款',
  customs_export: '阶段7：物流收款',
  payment_received: '阶段7：物流收款',
};

export interface AnalyticsSummary {
  totalOrders: number;
  totalMilestones: number;
  completedMilestones: number;
  completionRate: number;
  onTimeCount: number;
  onTimeRate: number;
  overdueCount: number;
  blockedCount: number;
  thisWeekCompleted: number;
  lastWeekCompleted: number;
}

export interface PhaseEfficiency {
  phase: string;
  completedCount: number;
  totalCount: number;
  onTimeCount: number;
  onTimeRate: number;
}

export interface RoleEfficiency {
  role: string;
  roleLabel: string;
  completedCount: number;
  overdueCount: number;
  onTimeCount: number;
  onTimeRate: number;
}

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('请先登录');
  const now = new Date();

  // 总订单数
  const { count: totalOrders } = await supabase.from('orders').select('*', { count: 'exact', head: true });

  // 所有里程碑
  const { data: allMilestones } = await (supabase.from('milestones') as any).select('id, status, due_at, actual_at, updated_at, step_key');
  const milestones = allMilestones || [];
  const totalMilestones = milestones.length;
  const completedMilestones = milestones.filter(m => _isDone((m as any).status)).length;
  const completionRate = totalMilestones > 0 ? Math.round(completedMilestones / totalMilestones * 100) : 0;

  // 准时率：(准时数) / (有截止日的已完成数 + 进行中已逾期数)
  // 准时判定：已完成 + actual_at/updated_at <= due_at
  // 进行中已逾期 → 计入分母（拉低准时率），不计入分子
  let onTimeCount = 0;
  let onTimeDoneBase = 0;
  let overdueInProgressCount = 0;
  milestones.forEach((m: any) => {
    if (!m.due_at) return;
    if (_isDone(m.status)) {
      onTimeDoneBase++;
      // 有actual_at用actual_at，否则用updated_at作为完成时间
      const completedDate = m.actual_at ? new Date(m.actual_at) : (m.updated_at ? new Date(m.updated_at) : null);
      if (completedDate && completedDate <= new Date(m.due_at)) {
        onTimeCount++;
      }
      // 无actual_at也无updated_at → 保守不计为准时
    } else if (_isActive(m.status) && new Date(m.due_at) < now) {
      overdueInProgressCount++;
    }
  });
  const onTimeBase = onTimeDoneBase + overdueInProgressCount;
  const onTimeRate = onTimeBase > 0 ? Math.round(onTimeCount / onTimeBase * 100) : 0;

  // 超期/阻塞
  const overdueCount = milestones.filter((m: any) =>
    _isActive(m.status) && m.due_at && new Date(m.due_at) < now
  ).length;
  const blockedCount = milestones.filter((m: any) => isBlockedStatus(m.status)).length;

  // 本周 vs 上周完成数
  const startOfWeek = new Date(now);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  const { count: thisWeekCompleted } = await (supabase.from('milestone_logs') as any)
    .select('*', { count: 'exact', head: true })
    .eq('action', 'mark_done')
    .gte('created_at', startOfWeek.toISOString());

  const { count: lastWeekCompleted } = await (supabase.from('milestone_logs') as any)
    .select('*', { count: 'exact', head: true })
    .eq('action', 'mark_done')
    .gte('created_at', startOfLastWeek.toISOString())
    .lt('created_at', startOfWeek.toISOString());

  return {
    totalOrders: totalOrders || 0,
    totalMilestones,
    completedMilestones,
    completionRate,
    onTimeCount,
    onTimeRate,
    overdueCount,
    blockedCount,
    thisWeekCompleted: thisWeekCompleted || 0,
    lastWeekCompleted: lastWeekCompleted || 0,
  };
}

export async function getPhaseEfficiency(): Promise<PhaseEfficiency[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('请先登录');

  const { data: milestones } = await (supabase.from('milestones') as any).select('id, status, due_at, actual_at, updated_at, step_key');
  const { data: doneLogs } = await (supabase.from('milestone_logs') as any)
    .select('milestone_id, created_at')
    .eq('action', 'mark_done');

  const doneLogMap = new Map<string, string>();
  (doneLogs || []).forEach((l: any) => {
    if (!doneLogMap.has(l.milestone_id) || l.created_at < doneLogMap.get(l.milestone_id)!) {
      doneLogMap.set(l.milestone_id, l.created_at);
    }
  });

  const now = new Date();
  const phaseData: Record<string, { total: number; completed: number; onTime: number; overdue: number }> = {};

  (milestones || []).forEach((m: any) => {
    const phase = PHASE_MAP[m.step_key];
    if (!phase) return;
    if (!phaseData[phase]) phaseData[phase] = { total: 0, completed: 0, onTime: 0, overdue: 0 };
    phaseData[phase].total += 1;

    if (_isDone(m.status)) {
      phaseData[phase].completed += 1;
      if (m.due_at) {
        const completedAt = m.actual_at ? new Date(m.actual_at) : (m.updated_at ? new Date(m.updated_at) : null);
        if (completedAt && completedAt <= new Date(m.due_at)) {
          phaseData[phase].onTime += 1;
        }
      }
    } else if ((m.status === 'in_progress' || m.status === '进行中') && m.due_at && new Date(m.due_at) < now) {
      phaseData[phase].overdue += 1;
    }
  });

  return Object.entries(phaseData)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([phase, data]) => ({
      phase,
      completedCount: data.completed,
      totalCount: data.total,
      onTimeCount: data.onTime,
      onTimeRate: (data.completed + data.overdue) > 0 ? Math.round(data.onTime / (data.completed + data.overdue) * 100) : 0,
    }));
}

export async function getRoleEfficiency(): Promise<RoleEfficiency[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('请先登录');
  const now = new Date();

  const { data: roleMilestones } = await (supabase.from('milestones') as any).select('id, status, due_at, actual_at, updated_at, owner_role');

  const roleData: Record<string, { completed: number; overdue: number; onTime: number }> = {};

  (roleMilestones || []).forEach((m: any) => {
    const role = m.owner_role || 'unknown';
    if (!roleData[role]) roleData[role] = { completed: 0, overdue: 0, onTime: 0 };

    if (_isDone(m.status)) {
      roleData[role].completed += 1;
      if (m.due_at) {
        const completedAt = m.actual_at ? new Date(m.actual_at) : (m.updated_at ? new Date(m.updated_at) : null);
        if (completedAt && completedAt <= new Date(m.due_at)) {
          roleData[role].onTime += 1;
        }
      }
    } else if (_isActive(m.status) && m.due_at && new Date(m.due_at) < now) {
      roleData[role].overdue += 1;
    }
  });

  return Object.entries(roleData)
    .sort((a, b) => b[1].completed - a[1].completed)
    .map(([role, data]) => ({
      role,
      roleLabel: getRoleLabel(role),
      completedCount: data.completed,
      overdueCount: data.overdue,
      onTimeCount: data.onTime,
      onTimeRate: (data.completed + data.overdue) > 0 ? Math.round(data.onTime / (data.completed + data.overdue) * 100) : 0,
    }));
}

// ══════════════════════════════════════════════════
// 月度出货分布 + AI 产能分析
// ══════════════════════════════════════════════════

export interface MonthlyShipment {
  month: string; label: string; orderCount: number; totalQuantity: number;
  completedCount: number; plannedCount: number; customers: string[]; factories: string[];
  // 三日期维度：当月有多少订单在该阶段
  orderDateCount: number;    // 下单月
  productionCount: number;   // 生产上线月（production_kickoff due_at）
  factoryDateCount: number;  // 出厂月
}

export async function getShipmentDistribution(): Promise<MonthlyShipment[]> {
  const supabase = await createClient();
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_name, quantity, factory_date, etd, order_date, created_at, incoterm, lifecycle_status')
    .not('lifecycle_status', 'eq', '已取消');
  if (!orders || orders.length === 0) return [];

  // 获取所有订单的 production_kickoff 节点（生产上线日期）
  const orderIds = orders.map((o: any) => o.id);
  const { data: prodMilestones } = await (supabase.from('milestones') as any)
    .select('order_id, due_at')
    .in('order_id', orderIds)
    .eq('step_key', 'production_kickoff');
  const prodDateMap = new Map<string, string>();
  for (const m of prodMilestones || []) {
    if (m.due_at) prodDateMap.set(m.order_id, m.due_at.slice(0, 7));
  }

  // 找出所有相关月份范围：从最早下单月到未来8个月
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

  // 收集所有涉及的月份
  const allMonthsSet = new Set<string>();
  for (const o of orders) {
    const orderMonth = (o.order_date || o.created_at || '').slice(0, 7);
    if (orderMonth) allMonthsSet.add(orderMonth);
    const factoryMonth = (o.factory_date || o.etd || '').slice(0, 7);
    if (factoryMonth) allMonthsSet.add(factoryMonth);
    const prodMonth = prodDateMap.get(o.id);
    if (prodMonth) allMonthsSet.add(prodMonth);
  }
  // 确保当月+未来8个月都在
  for (let i = 0; i <= 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    allMonthsSet.add(d.toISOString().slice(0, 7));
  }
  // 只保留最近12个月（过去3个月 + 当月 + 未来8个月）
  const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 7);
  const months = Array.from(allMonthsSet).filter(m => m >= threeMonthsAgo).sort();

  const monthMap = new Map<string, {
    orders: any[]; completed: number; planned: number; qty: number;
    customers: Set<string>; factories: Set<string>;
    orderDateCount: number; productionCount: number; factoryDateCount: number;
  }>();
  for (const m of months) monthMap.set(m, {
    orders: [], completed: 0, planned: 0, qty: 0, customers: new Set(), factories: new Set(),
    orderDateCount: 0, productionCount: 0, factoryDateCount: 0,
  });

  for (const o of orders) {
    // 下单月维度（用 order_date 或 created_at）
    const orderMonth = (o.order_date || o.created_at || '').slice(0, 7);
    const orderBucket = monthMap.get(orderMonth);
    if (orderBucket) orderBucket.orderDateCount++;

    // 生产上线月维度
    const prodMonth = prodDateMap.get(o.id);
    if (prodMonth) {
      const prodBucket = monthMap.get(prodMonth);
      if (prodBucket) prodBucket.productionCount++;
    }

    // 出厂月维度
    const shipDate = o.factory_date || o.etd;
    if (!shipDate) continue;
    const shipMonth = shipDate.slice(0, 7);
    const bucket = monthMap.get(shipMonth);
    if (bucket) {
      bucket.orders.push(o); bucket.qty += o.quantity || 0;
      bucket.factoryDateCount++;
      if (o.customer_name) bucket.customers.add(o.customer_name);
      if (o.factory_name) bucket.factories.add(o.factory_name);
      const ls = o.lifecycle_status || '';
      if (ls === '已完成' || ls === 'completed' || ls === '已复盘') bucket.completed++; else bucket.planned++;
    }

  }

  return months.map(m => {
    const b = monthMap.get(m)!;
    return { month: m, label: `${parseInt(m.split('-')[1])}月`, orderCount: b.orders.length, totalQuantity: b.qty,
      completedCount: b.completed, plannedCount: b.planned, customers: Array.from(b.customers), factories: Array.from(b.factories),
      orderDateCount: b.orderDateCount, productionCount: b.productionCount, factoryDateCount: b.factoryDateCount };
  });
}

export interface CapacityAnalysis {
  summary: string;
  monthlyInsights: Array<{ month: string; label: string; status: 'overload' | 'normal' | 'underload' | 'empty'; advice: string }>;
  recommendations: string[];
}

export async function getCapacityAIAnalysis(): Promise<CapacityAnalysis> {
  const distribution = await getShipmentDistribution();
  const dataStr = distribution.map(m => `${m.month}(${m.label}): 出厂${m.factoryDateCount}单/${m.totalQuantity}件 [完成${m.completedCount}/计划${m.plannedCount}] 下单${m.orderDateCount} 生产上线${m.productionCount} 客户${m.customers.length}家 工厂${m.factories.length}家`).join('\n');
  const currentMonth = new Date().toISOString().slice(0, 7);
  const prompt = `你是一位资深外贸服装生产管理顾问。以下是一家服装外贸公司过去6个月+未来6个月的订单出货分布：\n\n${dataStr}\n\n当前月份：${currentMonth}\n\n请分析：\n1. 对每个月给出产能状态（overload/normal/underload/empty）和一句话建议\n2. 总体排产形势（2-3句话）\n3. 3-5条行动建议（含：是否需要提前准备产能、哪些月可接加单、排产节奏、业务开发力度）\n\n返回JSON：{"summary":"...","monthlyInsights":[{"month":"2026-04","label":"4月","status":"normal","advice":"..."}],"recommendations":["..."]}\n只返回JSON。`;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();
    const response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { summary: parsed.summary || '分析完成',
        monthlyInsights: (parsed.monthlyInsights || []).map((i: any) => ({ month: i.month, label: i.label || i.month, status: i.status || 'normal', advice: i.advice || '' })),
        recommendations: parsed.recommendations || [] };
    }
  } catch (err: any) { console.error('[getCapacityAIAnalysis]', err?.message); }

  const avgQty = distribution.reduce((s, m) => s + m.totalQuantity, 0) / Math.max(distribution.length, 1);
  return { summary: `平均每月出货 ${Math.round(avgQty)} 件。`,
    monthlyInsights: distribution.map(m => ({ month: m.month, label: m.label,
      status: m.totalQuantity === 0 ? 'empty' as const : m.totalQuantity > avgQty * 1.5 ? 'overload' as const : m.totalQuantity < avgQty * 0.5 ? 'underload' as const : 'normal' as const,
      advice: m.totalQuantity === 0 ? '无订单，加大开发' : m.totalQuantity > avgQty * 1.5 ? '产能紧张' : m.totalQuantity < avgQty * 0.5 ? '可接加单' : '正常' })),
    recommendations: ['关注空档期，提前联系客户了解加单需求'] };
}
