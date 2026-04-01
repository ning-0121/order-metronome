'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

// 业务负责的关卡 step_keys
const SALES_STEPS = [
  'po_confirmed', 'production_order_upload', 'order_docs_bom_complete',
  'pre_production_sample_sent', 'pre_production_sample_approved',
  'materials_received_inspected', 'packing_method_confirmed',
  'shipping_sample_send', 'booking_done', 'customs_export',
];

// 跟单负责的关卡 step_keys
const MERCHANDISER_STEPS = [
  'factory_confirmed', 'pre_production_sample_ready',
  'production_kickoff', 'pre_production_meeting',
  'mid_qc_check', 'final_qc_check',
  'factory_completion', 'inspection_release',
];

// 品质相关关卡
const QC_STEPS = ['mid_qc_check', 'final_qc_check'];

// 出运关卡（用于准时交付判断）
const SHIPMENT_STEP = 'customs_export';

interface ScoreDetail {
  ontime: { score: number; max: 40; overdueSteps: string[] };
  noBlock: { score: number; max: 20; blockedSteps: string[] };
  noDelay: { score: number; max: 15; delayCount: number };
  quality: { score: number; max: 15; midPassed: boolean; finalPassed: boolean };
  delivery: { score: number; max: 10; daysLate: number | null };
}

function calcGrade(total: number): { grade: string; rate: number } {
  if (total >= 95) return { grade: 'S', rate: 1.10 };
  if (total >= 85) return { grade: 'A', rate: 1.00 };
  if (total >= 75) return { grade: 'B', rate: 0.85 };
  if (total >= 60) return { grade: 'C', rate: 0.70 };
  return { grade: 'D', rate: 0.50 };
}

/**
 * 为指定订单计算业务和跟单的执行评分。
 * 订单必须已完成（所有关卡 done）或已被标记为 completed。
 * 只读 + 写入 order_commissions，不修改订单/关卡数据。
 */
export async function calculateOrderScore(
  orderId: string,
  manualCalcBy?: string // 管理员手动触发时传入 user_id
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();

  // 获取订单信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, etd, warehouse_due_date, incoterm, owner_user_id, created_by')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // 获取所有关卡
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, step_key, name, status, due_at, actual_at, owner_role, owner_user_id')
    .eq('order_id', orderId)
    .order('due_at', { ascending: true });
  if (!milestones || milestones.length === 0) return { error: '无关卡数据' };

  // 获取延期申请
  const { data: delays } = await (supabase.from('delay_requests') as any)
    .select('id, milestone_id, requested_by, status')
    .eq('order_id', orderId);

  // 获取 milestone_logs 中的阻塞记录
  const milestoneIds = milestones.map((m: any) => m.id);
  const { data: blockLogs } = await (supabase.from('milestone_logs') as any)
    .select('milestone_id, action')
    .in('milestone_id', milestoneIds)
    .eq('action', 'mark_blocked');

  // 查找跟单负责人（从 merchandiser 关卡中找 owner_user_id）
  const merchandiserMilestone = milestones.find(
    (m: any) => m.owner_role === 'merchandiser' && m.owner_user_id
  );
  const merchandiserUserId = merchandiserMilestone?.owner_user_id || null;
  const salesUserId = order.owner_user_id || order.created_by;

  if (!salesUserId) return { error: '订单无业务负责人' };

  // ===== 计算共享维度 =====

  // 品质达标（共享）
  const midQc = milestones.find((m: any) => m.step_key === 'mid_qc_check');
  const finalQc = milestones.find((m: any) => m.step_key === 'final_qc_check');
  // 检查是否有阻塞记录（代表QC不通过）
  const midBlocked = blockLogs?.some((l: any) => l.milestone_id === midQc?.id) || false;
  const finalBlocked = blockLogs?.some((l: any) => l.milestone_id === finalQc?.id) || false;

  let qualityScore = 15;
  if (midBlocked) qualityScore -= 5;
  if (finalBlocked) qualityScore -= 10;
  qualityScore = Math.max(0, qualityScore);

  const qualityDetail = {
    score: qualityScore, max: 15 as const,
    midPassed: !midBlocked, finalPassed: !finalBlocked,
  };

  // 准时交付（共享）
  const shipmentMilestone = milestones.find((m: any) => m.step_key === SHIPMENT_STEP);
  const targetDate = order.incoterm === 'FOB' ? order.etd : order.warehouse_due_date;
  let deliveryScore = 10;
  let daysLate: number | null = null;

  if (shipmentMilestone && targetDate) {
    // 用关卡的 actual_at 或完成时的时间戳
    const completedAt = shipmentMilestone.actual_at || (shipmentMilestone.status === 'done' ? shipmentMilestone.due_at : null);
    if (completedAt) {
      const diff = Math.ceil(
        (new Date(completedAt).getTime() - new Date(targetDate).getTime()) / (1000 * 60 * 60 * 24)
      );
      daysLate = Math.max(0, diff);
      if (daysLate === 0) deliveryScore = 10;
      else if (daysLate <= 3) deliveryScore = 5;
      else if (daysLate <= 7) deliveryScore = 0;
      else deliveryScore = -5;
    }
  }

  const deliveryDetail = { score: deliveryScore, max: 10 as const, daysLate };

  // ===== 按角色计算个人维度 =====

  function calcRoleScore(roleSteps: string[]): ScoreDetail {
    const roleMilestones = milestones.filter((m: any) => roleSteps.includes(m.step_key));

    // 节拍准时率
    const overdueSteps: string[] = [];
    for (const m of roleMilestones) {
      if (m.due_at && m.status === 'done') {
        // 完成日期 > 截止日期 = 逾期
        const completedAt = m.actual_at || m.due_at;
        if (new Date(completedAt) > new Date(m.due_at)) {
          overdueSteps.push(m.name);
        }
      } else if (m.due_at && m.status !== 'done' && new Date(m.due_at) < new Date()) {
        overdueSteps.push(m.name);
      }
    }
    const ontimeScore = Math.max(0, 40 - overdueSteps.length * 8);

    // 零阻塞
    const blockedSteps: string[] = [];
    for (const m of roleMilestones) {
      if (blockLogs?.some((l: any) => l.milestone_id === m.id)) {
        blockedSteps.push(m.name);
      }
    }
    const noBlockScore = Math.max(0, 20 - blockedSteps.length * 10);

    // 延期控制 — 该角色关卡的延期申请数
    const roleDelays = (delays || []).filter((d: any) =>
      roleMilestones.some((m: any) => m.id === d.milestone_id)
    );
    const noDelayScore = Math.max(0, 15 - roleDelays.length * 5);

    return {
      ontime: { score: ontimeScore, max: 40, overdueSteps },
      noBlock: { score: noBlockScore, max: 20, blockedSteps },
      noDelay: { score: noDelayScore, max: 15, delayCount: roleDelays.length },
      quality: qualityDetail,
      delivery: deliveryDetail,
    };
  }

  const salesDetail = calcRoleScore(SALES_STEPS);
  const salesTotal = Math.min(110, Math.max(0,
    salesDetail.ontime.score + salesDetail.noBlock.score +
    salesDetail.noDelay.score + salesDetail.quality.score + salesDetail.delivery.score
  ));
  const salesGrade = calcGrade(salesTotal);

  // 检查一票否决
  const { data: cancelReqs } = await (supabase.from('cancel_requests') as any)
    .select('id, reason')
    .eq('order_id', orderId)
    .eq('status', 'approved');
  const vetoed = (cancelReqs || []).length > 0;
  const vetoReason = vetoed ? '订单已取消' : null;

  // 写入业务评分
  const salesPayload = {
    order_id: orderId,
    user_id: salesUserId,
    role: 'sales',
    score_ontime: salesDetail.ontime.score,
    score_no_block: salesDetail.noBlock.score,
    score_no_delay: salesDetail.noDelay.score,
    score_quality: salesDetail.quality.score,
    score_delivery: salesDetail.delivery.score,
    total_score: salesTotal,
    grade: vetoed ? 'D' : salesGrade.grade,
    commission_rate: vetoed ? 0 : salesGrade.rate,
    vetoed,
    veto_reason: vetoReason,
    detail_json: salesDetail,
    calculated_at: new Date().toISOString(),
    calculated_by: manualCalcBy || null,
  };

  await (supabase.from('order_commissions') as any)
    .upsert(salesPayload, { onConflict: 'order_id,user_id' });

  // 写入跟单评分（如有跟单负责人）
  if (merchandiserUserId) {
    const merchDetail = calcRoleScore(MERCHANDISER_STEPS);
    const merchTotal = Math.min(110, Math.max(0,
      merchDetail.ontime.score + merchDetail.noBlock.score +
      merchDetail.noDelay.score + merchDetail.quality.score + merchDetail.delivery.score
    ));
    const merchGrade = calcGrade(merchTotal);

    const merchPayload = {
      order_id: orderId,
      user_id: merchandiserUserId,
      role: 'merchandiser',
      score_ontime: merchDetail.ontime.score,
      score_no_block: merchDetail.noBlock.score,
      score_no_delay: merchDetail.noDelay.score,
      score_quality: merchDetail.quality.score,
      score_delivery: merchDetail.delivery.score,
      total_score: merchTotal,
      grade: vetoed ? 'D' : merchGrade.grade,
      commission_rate: vetoed ? 0 : merchGrade.rate,
      vetoed,
      veto_reason: vetoReason,
      detail_json: merchDetail,
      calculated_at: new Date().toISOString(),
      calculated_by: manualCalcBy || null,
    };

    await (supabase.from('order_commissions') as any)
      .upsert(merchPayload, { onConflict: 'order_id,user_id' });
  }

  revalidatePath(`/orders/${orderId}`);

  // 返回完整评分数据（供实时预览和最终结果使用）
  const result: any = {
    salesScore: { ...salesPayload, total_score: salesTotal, grade: vetoed ? 'D' : salesGrade.grade, detail_json: salesDetail },
  };
  if (merchandiserUserId) {
    const merchDetail = calcRoleScore(MERCHANDISER_STEPS);
    const merchTotal = Math.min(110, Math.max(0,
      merchDetail.ontime.score + merchDetail.noBlock.score +
      merchDetail.noDelay.score + merchDetail.quality.score + merchDetail.delivery.score
    ));
    const merchGrade = calcGrade(merchTotal);
    result.merchandiserScore = { total_score: merchTotal, grade: vetoed ? 'D' : merchGrade.grade, detail_json: merchDetail };
  }
  return { data: result };
}

/**
 * 获取订单的执行评分
 */
export async function getOrderCommissions(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data, error } = await (supabase.from('order_commissions') as any)
    .select('*')
    .eq('order_id', orderId);

  if (error) return { error: error.message };

  // 关联用户名
  if (data && data.length > 0) {
    const userIds = data.map((c: any) => c.user_id);
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email')
      .in('user_id', userIds);
    const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '未知']));
    for (const c of data) {
      c.user_name = profileMap.get(c.user_id) || '未知';
    }
  }

  return { data };
}

/**
 * 获取跟单候选人列表（角色为 merchandiser 的用户）
 */
export async function getMerchandiserCandidates() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data: profiles } = await (supabase.from('profiles') as any)
    .select('user_id, name, email, role, roles');

  const candidates = (profiles || []).filter((p: any) => {
    const roles: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
    return roles.includes('merchandiser') || roles.includes('admin');
  });

  return { data: candidates };
}
