'use server';

import { createClient } from '@/lib/supabase/server';

// ════════ 客户分析 ════════

export interface CustomerAnalytics {
  customerName: string;
  orderCount: number;
  totalQuantity: number;
  completedCount: number;
  activeCount: number;
  cancelledCount: number;
  onTimeCount: number;
  onTimeRate: number;
  avgScore: number;
  avgDefectRate: number;
  topDelayReasons: { reason: string; count: number }[];
  monthlyTrend: { month: string; orders: number; quantity: number }[];
  aiSummary: string;
}

export async function getCustomerAnalytics(
  customerName: string,
  period: 'month' | 'quarter' | 'year' = 'year'
): Promise<{ data?: CustomerAnalytics; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 时间范围
  const now = new Date();
  let since: Date;
  if (period === 'month') { since = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (period === 'quarter') { since = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); }
  else { since = new Date(now.getFullYear(), 0, 1); }

  // 订单数据
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, quantity, lifecycle_status, created_at')
    .eq('customer_name', customerName)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  const allOrders = orders || [];
  const orderIds = allOrders.map((o: any) => o.id);
  const orderCount = allOrders.length;
  const totalQuantity = allOrders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
  const completedCount = allOrders.filter((o: any) => o.lifecycle_status === 'completed' || o.lifecycle_status === '已完成').length;
  const activeCount = allOrders.filter((o: any) => !['completed', 'cancelled', '已完成', '已取消'].includes(o.lifecycle_status || '')).length;
  const cancelledCount = allOrders.filter((o: any) => o.lifecycle_status === 'cancelled' || o.lifecycle_status === '已取消').length;

  // 评分数据
  let avgScore = 0;
  let onTimeCount = 0;
  let totalDoneMilestones = 0;
  if (orderIds.length > 0) {
    const { data: commissions } = await (supabase.from('order_commissions') as any)
      .select('total_score').in('order_id', orderIds);
    if (commissions && commissions.length > 0) {
      avgScore = Math.round(commissions.reduce((s: number, c: any) => s + c.total_score, 0) / commissions.length);
    }

    // 准时率（基于关卡级别，与员工分析一致）
    const { data: doneMilestones } = await (supabase.from('milestones') as any)
      .select('due_at, actual_at')
      .in('order_id', orderIds)
      .eq('status', 'done');
    if (doneMilestones) {
      totalDoneMilestones = doneMilestones.length;
      for (const m of doneMilestones) {
        if (m.due_at && (!m.actual_at || new Date(m.actual_at) <= new Date(m.due_at))) {
          onTimeCount++;
        }
      }
    }
  }
  const onTimeRate = totalDoneMilestones > 0 ? Math.round((onTimeCount / totalDoneMilestones) * 100) : 0;

  // 不良率
  let avgDefectRate = 0;
  if (orderIds.length > 0) {
    const { data: reports } = await (supabase.from('production_reports') as any)
      .select('qty_produced, qty_defect').in('order_id', orderIds);
    if (reports && reports.length > 0) {
      const totalProd = reports.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0);
      const totalDef = reports.reduce((s: number, r: any) => s + (r.qty_defect || 0), 0);
      avgDefectRate = totalProd > 0 ? Math.round((totalDef / totalProd) * 1000) / 10 : 0;
    }
  }

  // 延期原因
  const topDelayReasons: { reason: string; count: number }[] = [];
  if (orderIds.length > 0) {
    const { data: delays } = await (supabase.from('delay_requests') as any)
      .select('reason_type').in('order_id', orderIds);
    if (delays) {
      const counts: Record<string, number> = {};
      const labels: Record<string, string> = {
        customer_confirmation: '客户确认延迟', supplier_delay: '供应商延迟',
        internal_delay: '内部延迟', logistics: '物流延迟', other: '其他',
      };
      for (const d of delays) {
        const r = d.reason_type || 'other';
        counts[r] = (counts[r] || 0) + 1;
      }
      for (const [reason, count] of Object.entries(counts).sort(([, a], [, b]) => b - a)) {
        topDelayReasons.push({ reason: labels[reason] || reason, count });
      }
    }
  }

  // 月度趋势
  const monthlyTrend: { month: string; orders: number; quantity: number }[] = [];
  const monthMap: Record<string, { orders: number; quantity: number }> = {};
  for (const o of allOrders) {
    const d = new Date(o.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap[key]) monthMap[key] = { orders: 0, quantity: 0 };
    monthMap[key].orders++;
    monthMap[key].quantity += o.quantity || 0;
  }
  for (const [month, data] of Object.entries(monthMap).sort()) {
    monthlyTrend.push({ month, ...data });
  }

  // AI 总结（纯算法）
  const parts: string[] = [];
  parts.push(`${customerName} ${period === 'year' ? '本年度' : period === 'quarter' ? '本季度' : '本月'}共 ${orderCount} 个订单，总数量 ${totalQuantity} 件。`);
  if (completedCount > 0) parts.push(`已完成 ${completedCount} 个，准时交付率 ${onTimeRate}%。`);
  if (activeCount > 0) parts.push(`当前在执行 ${activeCount} 个。`);
  if (avgScore > 0) parts.push(`平均执行评分 ${avgScore} 分。`);
  if (avgDefectRate > 3) parts.push(`注意：平均不良率 ${avgDefectRate}% 偏高，需关注品质。`);
  if (cancelledCount > 0) parts.push(`有 ${cancelledCount} 个取消订单，需分析原因。`);
  if (topDelayReasons.length > 0) parts.push(`最常见延期原因：${topDelayReasons[0].reason}（${topDelayReasons[0].count}次）。`);

  return {
    data: {
      customerName, orderCount, totalQuantity, completedCount, activeCount, cancelledCount,
      onTimeCount, onTimeRate, avgScore, avgDefectRate,
      topDelayReasons, monthlyTrend,
      aiSummary: parts.join(''),
    },
  };
}

// ════════ 员工分析 ════════

export interface EmployeeAnalytics {
  userId: string;
  name: string;
  role: string;
  activeOrders: number;
  completedOrders: number;
  totalQuantity: number;
  avgScore: number;
  gradeDistribution: Record<string, number>;
  onTimeRate: number;
  delayCount: number;
  blockCount: number;
  monthlyTrend: { month: string; completed: number; score: number }[];
  aiSummary: string;
}

export async function getEmployeeAnalytics(
  targetUserId: string,
  period: 'month' | 'quarter' | 'year' = 'year'
): Promise<{ data?: EmployeeAnalytics; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data: targetProfile } = await (supabase.from('profiles') as any)
    .select('name, email, role, roles').eq('user_id', targetUserId).single();
  if (!targetProfile) return { error: '用户不存在' };

  const name = targetProfile.name || targetProfile.email?.split('@')[0] || '未知';
  const roles: string[] = targetProfile.roles?.length > 0 ? targetProfile.roles : [targetProfile.role].filter(Boolean);
  const role = roles.includes('sales') ? '业务/理单' : roles.includes('merchandiser') ? '跟单' : roles.join('/');

  const now = new Date();
  let since: Date;
  if (period === 'month') { since = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (period === 'quarter') { since = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); }
  else { since = new Date(now.getFullYear(), 0, 1); }

  // 负责的订单（创建的 + 被分配关卡的）
  const { data: createdOrders } = await (supabase.from('orders') as any)
    .select('id, quantity, lifecycle_status, created_at')
    .eq('owner_user_id', targetUserId)
    .gte('created_at', since.toISOString());
  const { data: assignedMs } = await (supabase.from('milestones') as any)
    .select('order_id').eq('owner_user_id', targetUserId);
  const orderIdSet = new Set([
    ...(createdOrders || []).map((o: any) => o.id),
    ...(assignedMs || []).map((m: any) => m.order_id),
  ]);

  // 去重获取订单详情
  let allOrders: any[] = [];
  if (orderIdSet.size > 0) {
    const { data } = await (supabase.from('orders') as any)
      .select('id, quantity, lifecycle_status, created_at')
      .in('id', [...orderIdSet])
      .gte('created_at', since.toISOString());
    allOrders = data || [];
  }

  const activeOrders = allOrders.filter((o: any) => !['completed', 'cancelled', '已完成', '已取消'].includes(o.lifecycle_status || '')).length;
  const completedOrders = allOrders.filter((o: any) => o.lifecycle_status === 'completed' || o.lifecycle_status === '已完成').length;
  const totalQuantity = allOrders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);

  // 评分数据
  const { data: commissions } = await (supabase.from('order_commissions') as any)
    .select('total_score, grade, calculated_at, order_id')
    .eq('user_id', targetUserId);
  const periodCommissions = (commissions || []).filter((c: any) => new Date(c.calculated_at) >= since);
  const avgScore = periodCommissions.length > 0
    ? Math.round(periodCommissions.reduce((s: number, c: any) => s + c.total_score, 0) / periodCommissions.length)
    : 0;

  const gradeDistribution: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const c of periodCommissions) {
    gradeDistribution[c.grade] = (gradeDistribution[c.grade] || 0) + 1;
  }

  // 准时率（从该用户负责的关卡）
  let onTimeMilestones = 0;
  let totalDoneMilestones = 0;
  if (orderIdSet.size > 0) {
    const { data: myMilestones } = await (supabase.from('milestones') as any)
      .select('status, due_at, actual_at')
      .eq('owner_user_id', targetUserId)
      .in('order_id', [...orderIdSet]);
    for (const m of myMilestones || []) {
      if (m.status === 'done' || m.status === '已完成') {
        totalDoneMilestones++;
        if (m.due_at && (!m.actual_at || new Date(m.actual_at) <= new Date(m.due_at))) {
          onTimeMilestones++;
        }
      }
    }
  }
  const onTimeRate = totalDoneMilestones > 0 ? Math.round((onTimeMilestones / totalDoneMilestones) * 100) : 0;

  // 延期和阻塞
  let delayCount = 0;
  let blockCount = 0;
  if (orderIdSet.size > 0) {
    const { data: delays } = await (supabase.from('delay_requests') as any)
      .select('id').eq('requested_by', targetUserId).gte('created_at', since.toISOString());
    delayCount = (delays || []).length;

    const { data: blocks } = await (supabase.from('milestone_logs') as any)
      .select('id').eq('actor_user_id', targetUserId).eq('action', 'mark_blocked').gte('created_at', since.toISOString());
    blockCount = (blocks || []).length;
  }

  // 月度趋势
  const monthlyTrend: { month: string; completed: number; score: number }[] = [];
  const monthScores: Record<string, { completed: number; scores: number[] }> = {};
  for (const c of periodCommissions) {
    const d = new Date(c.calculated_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthScores[key]) monthScores[key] = { completed: 0, scores: [] };
    monthScores[key].completed++;
    monthScores[key].scores.push(c.total_score);
  }
  for (const [month, data] of Object.entries(monthScores).sort()) {
    monthlyTrend.push({
      month,
      completed: data.completed,
      score: Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length),
    });
  }

  // AI 总结
  const parts: string[] = [];
  parts.push(`${name}（${role}）`);
  parts.push(`${period === 'year' ? '本年度' : period === 'quarter' ? '本季度' : '本月'}负责 ${allOrders.length} 个订单，总数量 ${totalQuantity} 件。`);
  if (activeOrders > 0) parts.push(`当前在手 ${activeOrders} 个。`);
  if (avgScore >= 95) parts.push(`平均评分 ${avgScore} 分，表现卓越！`);
  else if (avgScore >= 85) parts.push(`平均评分 ${avgScore} 分，执行优秀。`);
  else if (avgScore >= 75) parts.push(`平均评分 ${avgScore} 分，基本达标。`);
  else if (avgScore > 0) parts.push(`平均评分 ${avgScore} 分，需要改进。`);
  if (onTimeRate > 0) parts.push(`关卡准时率 ${onTimeRate}%。`);
  if (delayCount > 2) parts.push(`延期申请 ${delayCount} 次，建议加强时间管理。`);
  if (blockCount > 1) parts.push(`阻塞 ${blockCount} 次，需关注执行瓶颈。`);

  return {
    data: {
      userId: targetUserId, name, role,
      activeOrders, completedOrders, totalQuantity,
      avgScore, gradeDistribution, onTimeRate,
      delayCount, blockCount, monthlyTrend,
      aiSummary: parts.join(''),
    },
  };
}

// ════════ 员工排行榜 ════════

export interface EmployeeRanking {
  userId: string;
  name: string;
  role: string;
  orderCount: number;
  activeCount: number;
  avgScore: number;
  onTimeRate: number;
}

export async function getEmployeeRanking(
  period: 'month' | 'quarter' | 'year' = 'year'
): Promise<{ data: EmployeeRanking[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };

  // 时间范围
  const now = new Date();
  let since: Date;
  if (period === 'month') { since = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (period === 'quarter') { since = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); }
  else { since = new Date(now.getFullYear(), 0, 1); }

  // 获取所有业务和跟单用户
  const { data: profiles } = await (supabase.from('profiles') as any)
    .select('user_id, name, email, role, roles');

  const rankings: EmployeeRanking[] = [];

  for (const p of profiles || []) {
    const roles: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
    if (!roles.some(r => ['sales', 'merchandiser'].includes(r))) continue;

    const role = roles.includes('sales') ? '业务/理单' : '跟单';
    const name = p.name || p.email?.split('@')[0] || '未知';

    // 订单数（按时间过滤）
    const { data: owned } = await (supabase.from('orders') as any)
      .select('id, lifecycle_status').eq('owner_user_id', p.user_id)
      .gte('created_at', since.toISOString());
    const { data: assigned } = await (supabase.from('milestones') as any)
      .select('order_id').eq('owner_user_id', p.user_id);
    const assignedOrderIds = (assigned || []).map((m: any) => m.order_id);
    // 过滤被分配关卡的订单也要在时间范围内
    let assignedInPeriod: string[] = [];
    if (assignedOrderIds.length > 0) {
      const { data: assignedOrders } = await (supabase.from('orders') as any)
        .select('id').in('id', assignedOrderIds)
        .gte('created_at', since.toISOString());
      assignedInPeriod = (assignedOrders || []).map((o: any) => o.id);
    }
    const orderIds = new Set([
      ...(owned || []).map((o: any) => o.id),
      ...assignedInPeriod,
    ]);
    const orderCount = orderIds.size;
    const activeCount = (owned || []).filter((o: any) => !['completed', 'cancelled', '已完成', '已取消'].includes(o.lifecycle_status || '')).length;

    // 平均评分（按时间过滤）
    const { data: scores } = await (supabase.from('order_commissions') as any)
      .select('total_score, calculated_at').eq('user_id', p.user_id);
    const periodScores = (scores || []).filter((c: any) => new Date(c.calculated_at) >= since);
    const avgScore = periodScores.length > 0
      ? Math.round(periodScores.reduce((s: number, c: any) => s + c.total_score, 0) / periodScores.length)
      : 0;

    // 准时率（按时间过滤）
    const { data: myMs } = await (supabase.from('milestones') as any)
      .select('status, due_at, actual_at, order_id').eq('owner_user_id', p.user_id).eq('status', 'done');
    const periodMs = (myMs || []).filter((m: any) => orderIds.has(m.order_id));
    let onTime = 0;
    const total = periodMs.length;
    for (const m of periodMs) {
      if (m.due_at && (!m.actual_at || new Date(m.actual_at) <= new Date(m.due_at))) onTime++;
    }
    const onTimeRate = total > 0 ? Math.round((onTime / total) * 100) : 0;

    if (orderCount > 0) {
      rankings.push({ userId: p.user_id, name, role, orderCount, activeCount, avgScore, onTimeRate });
    }
  }

  rankings.sort((a, b) => b.avgScore - a.avgScore || b.orderCount - a.orderCount);
  return { data: rankings };
}

// ════════ 客户列表 ════════

export async function getCustomerList(): Promise<{ data: { name: string; orderCount: number }[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };

  const { data: orders } = await (supabase.from('orders') as any)
    .select('customer_name');

  const counts: Record<string, number> = {};
  for (const o of orders || []) {
    if (o.customer_name) counts[o.customer_name] = (counts[o.customer_name] || 0) + 1;
  }

  return {
    data: Object.entries(counts)
      .map(([name, orderCount]) => ({ name, orderCount }))
      .sort((a, b) => b.orderCount - a.orderCount),
  };
}
