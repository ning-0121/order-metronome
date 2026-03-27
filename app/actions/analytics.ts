'use server';

import { createClient } from '@/lib/supabase/server';
import { getRoleLabel } from '@/lib/utils/i18n';

const _isDone = (s: string) => s === 'done' || s === '已完成' || s === 'completed';

// 阶段映射
const PHASE_MAP: Record<string, string> = {
  po_confirmed: '阶段1：订单启动',
  finance_approval: '阶段1：订单启动',
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
  const now = new Date();

  // 总订单数
  const { count: totalOrders } = await supabase.from('orders').select('*', { count: 'exact', head: true });

  // 所有里程碑
  const { data: allMilestones } = await supabase.from('milestones').select('id, status, due_at, step_key');
  const milestones = allMilestones || [];
  const totalMilestones = milestones.length;
  const completedMilestones = milestones.filter(m => _isDone((m as any).status)).length;
  const completionRate = totalMilestones > 0 ? Math.round(completedMilestones / totalMilestones * 100) : 0;

  // 准时率：完成的里程碑中，有多少在 due_at 之前完成
  // 简化：用 milestone_logs 的 mark_done 时间对比 due_at
  const { data: doneLogs } = await (supabase.from('milestone_logs') as any)
    .select('milestone_id, created_at')
    .eq('action', 'mark_done');

  const doneLogMap = new Map<string, string>();
  (doneLogs || []).forEach((l: any) => {
    // 取最早的 mark_done 时间
    if (!doneLogMap.has(l.milestone_id) || l.created_at < doneLogMap.get(l.milestone_id)!) {
      doneLogMap.set(l.milestone_id, l.created_at);
    }
  });

  let onTimeCount = 0;
  milestones.forEach((m: any) => {
    if (!_isDone(m.status) || !m.due_at) return;
    const doneAt = doneLogMap.get(m.id);
    if (doneAt && new Date(doneAt) <= new Date(m.due_at)) {
      onTimeCount++;
    }
  });
  const onTimeRate = completedMilestones > 0 ? Math.round(onTimeCount / completedMilestones * 100) : 0;

  // 超期/阻塞
  const overdueCount = milestones.filter((m: any) =>
    !_isDone(m.status) && m.due_at && new Date(m.due_at) < now
  ).length;
  const blockedCount = milestones.filter((m: any) =>
    m.status === 'blocked' || m.status === '卡住' || m.status === '卡单'
  ).length;

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

  const { data: milestones } = await supabase.from('milestones').select('id, status, due_at, step_key');
  const { data: doneLogs } = await (supabase.from('milestone_logs') as any)
    .select('milestone_id, created_at')
    .eq('action', 'mark_done');

  const doneLogMap = new Map<string, string>();
  (doneLogs || []).forEach((l: any) => {
    if (!doneLogMap.has(l.milestone_id) || l.created_at < doneLogMap.get(l.milestone_id)!) {
      doneLogMap.set(l.milestone_id, l.created_at);
    }
  });

  const phaseData: Record<string, { total: number; completed: number; onTime: number }> = {};

  (milestones || []).forEach((m: any) => {
    const phase = PHASE_MAP[m.step_key];
    if (!phase) return;
    if (!phaseData[phase]) phaseData[phase] = { total: 0, completed: 0, onTime: 0 };
    phaseData[phase].total += 1;

    if (_isDone(m.status)) {
      phaseData[phase].completed += 1;
      const doneAt = doneLogMap.get(m.id);
      if (m.due_at && doneAt && new Date(doneAt) <= new Date(m.due_at)) {
        phaseData[phase].onTime += 1;
      }
    }
  });

  return Object.entries(phaseData)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([phase, data]) => ({
      phase,
      completedCount: data.completed,
      totalCount: data.total,
      onTimeCount: data.onTime,
      onTimeRate: data.completed > 0 ? Math.round(data.onTime / data.completed * 100) : 0,
    }));
}

export async function getRoleEfficiency(): Promise<RoleEfficiency[]> {
  const supabase = await createClient();
  const now = new Date();

  const { data: milestones } = await supabase.from('milestones').select('id, status, due_at, owner_role');
  const { data: doneLogs } = await (supabase.from('milestone_logs') as any)
    .select('milestone_id, created_at')
    .eq('action', 'mark_done');

  const doneLogMap = new Map<string, string>();
  (doneLogs || []).forEach((l: any) => {
    if (!doneLogMap.has(l.milestone_id) || l.created_at < doneLogMap.get(l.milestone_id)!) {
      doneLogMap.set(l.milestone_id, l.created_at);
    }
  });

  const roleData: Record<string, { completed: number; overdue: number; onTime: number }> = {};

  (milestones || []).forEach((m: any) => {
    const role = m.owner_role || 'unknown';
    if (!roleData[role]) roleData[role] = { completed: 0, overdue: 0, onTime: 0 };

    if (_isDone(m.status)) {
      roleData[role].completed += 1;
      const doneAt = doneLogMap.get(m.id);
      if (m.due_at && doneAt && new Date(doneAt) <= new Date(m.due_at)) {
        roleData[role].onTime += 1;
      }
    } else if (m.due_at && new Date(m.due_at) < now) {
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
      onTimeRate: data.completed > 0 ? Math.round(data.onTime / data.completed * 100) : 0,
    }));
}
