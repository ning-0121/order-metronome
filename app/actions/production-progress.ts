'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface ProductionReport {
  id: string;
  order_id: string;
  report_date: string;
  reported_by: string | null;
  reporter_name?: string;
  qty_produced: number;
  qty_cumulative: number;
  qty_defect: number;
  defect_rate: number;
  workers_count: number | null;
  efficiency_rate: number | null;
  issues: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProductionAnalysis {
  totalQty: number;
  completedQty: number;
  progressRate: number;        // 完成率 %
  timeProgressRate: number;    // 时间进度 %
  daysUsed: number;
  daysRemaining: number;
  totalProductionDays: number;
  dailyAvgOutput: number;      // 日均产量
  requiredDailyOutput: number; // 剩余需日均
  totalDefects: number;
  avgDefectRate: number;
  riskLevel: 'green' | 'yellow' | 'red';
  riskLabel: string;
  suggestion: string;
}

export async function getProductionReports(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data, error } = await (supabase.from('production_reports') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('report_date', { ascending: false });

  if (error) return { error: error.message };

  // 关联报告人姓名
  const reports = (data || []) as ProductionReport[];
  if (reports.length > 0) {
    const userIds = [...new Set(reports.map(r => r.reported_by).filter(Boolean))];
    if (userIds.length > 0) {
      const { data: profiles } = await (supabase.from('profiles') as any)
        .select('user_id, name, email')
        .in('user_id', userIds);
      const map = new Map((profiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '未知']));
      for (const r of reports) {
        r.reporter_name = r.reported_by ? (map.get(r.reported_by) as string) || '未知' : '未知';
      }
    }
  }

  return { data: reports };
}

export async function addProductionReport(
  orderId: string,
  report: {
    report_date: string;
    qty_produced: number;
    qty_defect: number;
    workers_count?: number;
    issues?: string;
    notes?: string;
  }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 权限：跟单或业务可填写
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canReport = userRoles.some(r => ['sales', 'merchandiser', 'admin'].includes(r));
  if (!canReport) return { error: '仅跟单或业务可更新生产进度' };

  // 计算累计产量
  const { data: existing } = await (supabase.from('production_reports') as any)
    .select('qty_produced')
    .eq('order_id', orderId)
    .order('report_date', { ascending: true });

  const prevCumulative = (existing || []).reduce((sum: number, r: any) => sum + (r.qty_produced || 0), 0);
  const qty_cumulative = prevCumulative + report.qty_produced;

  const { error } = await (supabase.from('production_reports') as any).insert({
    order_id: orderId,
    reported_by: user.id,
    report_date: report.report_date,
    qty_produced: report.qty_produced,
    qty_cumulative,
    qty_defect: report.qty_defect || 0,
    workers_count: report.workers_count || null,
    issues: report.issues || null,
    notes: report.notes || null,
  });

  if (error) {
    if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
      return { error: '该日期已有记录，每天只能提交一条日报' };
    }
    return { error: error.message };
  }

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

export async function deleteProductionReport(reportId: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!userRoles.includes('admin')) return { error: '仅管理员可删除日报' };

  await (supabase.from('production_reports') as any).delete().eq('id', reportId);
  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * AI 生产进度分析（纯算法，不调 API）
 */
export async function getProductionAnalysis(orderId: string): Promise<{ data?: ProductionAnalysis; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 获取订单信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('quantity, etd, warehouse_due_date, incoterm')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  const totalQty = order.quantity || 0;
  if (totalQty === 0) return { error: '订单未设置数量，无法分析' };

  // 获取生产启动和工厂完成关卡日期
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('step_key, due_at, status')
    .eq('order_id', orderId)
    .in('step_key', ['production_kickoff', 'factory_completion']);

  const kickoff = (milestones || []).find((m: any) => m.step_key === 'production_kickoff');
  const completion = (milestones || []).find((m: any) => m.step_key === 'factory_completion');

  if (!kickoff?.due_at || !completion?.due_at) return { error: '缺少生产启动或工厂完成日期' };

  const startDate = new Date(kickoff.due_at);
  const endDate = new Date(completion.due_at);
  const now = new Date();

  const totalProductionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000));
  const daysUsed = Math.max(0, Math.ceil((now.getTime() - startDate.getTime()) / 86400000));
  const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / 86400000));

  // 获取生产日报
  const { data: reports } = await (supabase.from('production_reports') as any)
    .select('qty_produced, qty_defect')
    .eq('order_id', orderId);

  const completedQty = (reports || []).reduce((sum: number, r: any) => sum + (r.qty_produced || 0), 0);
  const totalDefects = (reports || []).reduce((sum: number, r: any) => sum + (r.qty_defect || 0), 0);

  const progressRate = Math.round((completedQty / totalQty) * 100);
  const timeProgressRate = Math.round((daysUsed / totalProductionDays) * 100);
  const dailyAvgOutput = daysUsed > 0 ? Math.round(completedQty / daysUsed) : 0;
  const requiredDailyOutput = daysRemaining > 0 ? Math.ceil((totalQty - completedQty) / daysRemaining) : 0;
  const avgDefectRate = completedQty > 0 ? Math.round((totalDefects / completedQty) * 1000) / 10 : 0;

  // 风险评估
  let riskLevel: 'green' | 'yellow' | 'red' = 'green';
  let riskLabel = '正常';
  let suggestion = '';

  if (daysUsed === 0 || (reports || []).length === 0) {
    riskLevel = 'green';
    riskLabel = '待开始';
    suggestion = '生产尚未开始或未提交日报，请跟单及时更新进度。';
  } else if (progressRate >= timeProgressRate) {
    riskLevel = 'green';
    riskLabel = '正常';
    suggestion = `生产进度正常，完成率 ${progressRate}% 超过时间进度 ${timeProgressRate}%，继续保持。`;
  } else if (progressRate >= timeProgressRate - 10) {
    riskLevel = 'yellow';
    riskLabel = '注意';
    suggestion = `生产略有滞后，完成率 ${progressRate}% 低于时间进度 ${timeProgressRate}%。日均需 ${requiredDailyOutput} 件，当前日均 ${dailyAvgOutput} 件，需要加快。`;
  } else {
    riskLevel = 'red';
    riskLabel = '危险';
    suggestion = `生产严重滞后！完成率 ${progressRate}% 远低于时间进度 ${timeProgressRate}%。剩余 ${daysRemaining} 天需完成 ${totalQty - completedQty} 件（日均 ${requiredDailyOutput} 件），当前日均仅 ${dailyAvgOutput} 件，请立即协调！`;
  }

  if (avgDefectRate > 5) {
    suggestion += ` 注意：不良率 ${avgDefectRate}% 偏高，请关注品质。`;
  }

  return {
    data: {
      totalQty, completedQty, progressRate, timeProgressRate,
      daysUsed, daysRemaining, totalProductionDays,
      dailyAvgOutput, requiredDailyOutput,
      totalDefects, avgDefectRate,
      riskLevel, riskLabel, suggestion,
    },
  };
}
