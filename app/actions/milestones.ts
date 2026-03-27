'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { isOverdue, addWorkingDays, ensureBusinessDay } from '@/lib/utils/date';
import {
  updateMilestone,
  createMilestone,
  transitionMilestoneStatus,
} from '@/lib/repositories/milestonesRepo';
import { normalizeMilestoneStatus } from '@/lib/domain/types';
import type { MilestoneStatus } from '@/lib/types';
import { classifyRequirement } from '@/lib/domain/requirements';

type MilestoneLogAction =
  | 'mark_done'
  | 'mark_in_progress'
  | 'mark_blocked'
  | 'unblock'
  | 'auto_advance'
  | 'request_delay'
  | 'approve_delay'
  | 'reject_delay'
  | 'recalc_schedule'
  | 'upload_evidence'
  | 'update'
  | 'execution_note';

async function logMilestoneAction(
  supabase: any,
  milestoneId: string,
  orderId: string,
  action: MilestoneLogAction,
  note?: string,
  payload?: any
) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await supabase.from('milestone_logs').insert({
    milestone_id: milestoneId,
    order_id: orderId,
    actor_user_id: user.id,
    action,
    note: note || null,
    payload: payload || null,
  });
}

export async function getMilestonesByOrder(orderId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  // Get milestones
  const { data: milestones, error } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('due_at', { ascending: true });
  
  if (error) {
    return { error: error.message };
  }
  
  // Get owner user IDs
  const ownerUserIds = (milestones || [])
    .map((m: any) => m.owner_user_id)
    .filter((id: string | null) => id !== null) as string[];
  
  // Get user profiles if there are any owner_user_ids
  let userMap: Record<string, any> = {};
  if (ownerUserIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role')
      .in('user_id', ownerUserIds);
    if (profiles) {
      userMap = (profiles as any[]).reduce((acc: Record<string, any>, p: any) => {
        acc[p.user_id] = { ...p, full_name: p.name ?? p.email };
        return acc;
      }, {});
    }
  }
  
  // Attach user info to milestones
  const milestonesWithUsers = (milestones || []).map((m: any) => ({
    ...m,
    owner_user: m.owner_user_id ? userMap[m.owner_user_id] || null : null,
  }));
  
  return { data: milestonesWithUsers };
}

export async function getUserMilestones(userId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: milestones, error } = await supabase
    .from('milestones')
    .select('*, orders(*)')
    .eq('owner_user_id', userId)
    .order('due_at', { ascending: true });
  
  if (error) {
    return { error: error.message };
  }
  
  return { data: milestones };
}

export async function markMilestoneDone(milestoneId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // Get current milestone (for order_id, evidence_required, owner_role, step_key, status)
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('order_id, evidence_required, owner_role, owner_user_id, step_key, status')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || '找不到该执行节点' };
  }

  // Check role: must be admin, assigned user, or matching owner_role (V2: multi-role)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdminUser = userRoles.includes('admin');
  const isAssignedUser = milestone.owner_user_id === user.id;
  const roleMatches = milestone.owner_role && userRoles.some(
    (r: string) => r.toLowerCase() === (milestone.owner_role as string).toLowerCase()
      || (milestone.owner_role === 'qc' && (r === 'qc' || r === 'quality'))
  );
  if (!isAdminUser && !isAssignedUser && !roleMatches) {
    return { error: '无权操作：只有管理员或负责人可以标记完成' };
  }

  // Check if evidence is required and exists
  if (milestone.evidence_required) {
    const { data: attachments, error: attachmentsError } = await supabase
      .from('attachments')
      .select('id')
      .eq('milestone_id', milestoneId)
      .limit(1);
    
    if (attachmentsError) {
      return { error: `凭证检查失败：${attachmentsError.message}` };
    }
    
    if (!attachments || attachments.length === 0) {
      return { error: '此节点需要上传凭证后才能标记完成，请先在「去处理」中上传文件' };
    }
  }
  
  // 如果当前是「未开始」，先自动转为「进行中」再转为「已完成」
  const currentDbStatus = (milestone as any).status;
  const normalizedCurrentStatus = normalizeMilestoneStatus(currentDbStatus);
  if (normalizedCurrentStatus === '未开始') {
    const advanceResult = await transitionMilestoneStatus(milestoneId, '进行中', '自动推进：标记完成时自动启动');
    if (advanceResult.error) {
      return { error: advanceResult.error };
    }
  }

  // 使用状态机转换（带校验）
  const result = await transitionMilestoneStatus(milestoneId, '已完成', null);
  
  if (result.error || !result.data) {
    return { error: result.error || '节点状态更新失败，请重试' };
  }
  
  const updatedMilestone = result.data;
  const milestoneData = milestone as any;

  // 财务审核完成 → 动态更新"生产单上传"截止日为 now + 2 工作日
  if (milestoneData.step_key === 'finance_approval') {
    const newDue = ensureBusinessDay(addWorkingDays(new Date(), 2));
    await (supabase.from('milestones') as any)
      .update({ due_at: newDue.toISOString() })
      .eq('order_id', milestoneData.order_id)
      .eq('step_key', 'production_order_upload');
  }

  // 采购下单完成 → 检查到货日期是否有交期风险
  if (milestoneData.step_key === 'procurement_order_placed' && milestoneData.actual_at) {
    const actualDelivery = new Date(milestoneData.actual_at);
    // 获取订单的 ETD/交期
    const { data: orderData } = await supabase
      .from('orders')
      .select('etd, warehouse_due_date, incoterm, order_no, customer_name')
      .eq('id', milestoneData.order_id)
      .single();
    if (orderData) {
      const anchor = (orderData as any).incoterm === 'FOB'
        ? (orderData as any).etd
        : (orderData as any).warehouse_due_date;
      if (anchor) {
        const anchorDate = new Date(anchor + 'T00:00:00');
        // 安全线 = 交期前21天（需要留够生产时间）
        const safetyDate = new Date(anchorDate);
        safetyDate.setDate(safetyDate.getDate() - 21);
        const delayDays = Math.ceil((actualDelivery.getTime() - safetyDate.getTime()) / (1000 * 60 * 60 * 24));
        if (delayDays > 0) {
          // 交期风险！创建通知给管理员
          const adminEmails = ['alex@qimoclothing.com', 'su@qimoclothing.com'];
          const { data: adminProfiles } = await (supabase
            .from('profiles') as any)
            .select('user_id')
            .in('email', adminEmails);
          for (const admin of (adminProfiles || [])) {
            await (supabase.from('notifications') as any).insert({
              user_id: admin.user_id,
              type: 'delivery_risk',
              title: `🚨 交期风险预警：${(orderData as any).order_no}`,
              content: `订单 ${(orderData as any).order_no}（${(orderData as any).customer_name}）原料到货日期超出安全线 ${delayDays} 天。需决策：压缩生产赶货 或 与客户推交期。`,
              order_id: milestoneData.order_id,
              is_read: false,
            });
          }
        }
      }
    }
  }

  // Auto-advance to next milestone
  await autoAdvanceNextMilestone(supabase, milestoneData.order_id);
  
  revalidatePath(`/orders/${milestoneData.order_id}`);
  revalidatePath('/dashboard');
  revalidatePath('/orders');
  
  return { data: updatedMilestone };
}

export async function markMilestoneBlocked(milestoneId: string, blockedReason: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  if (!blockedReason || blockedReason.trim() === '') {
    return { error: '请填写阻塞说明' };
  }

  // Get current milestone (for order_id and role check)
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('order_id, owner_role, owner_user_id')
    .eq('id', milestoneId)
    .single();

  if (getError || !milestone) {
    return { error: getError?.message || '找不到该执行节点' };
  }

  // Check role: must be admin, assigned user, or matching owner_role (V2: multi-role)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdminUser = userRoles.includes('admin');
  const isAssignedUser = milestone.owner_user_id === user.id;
  const roleMatches = milestone.owner_role && userRoles.some(
    (r: string) => r.toLowerCase() === (milestone.owner_role as string).toLowerCase()
      || (milestone.owner_role === 'qc' && (r === 'qc' || r === 'quality'))
  );
  if (!isAdminUser && !isAssignedUser && !roleMatches) {
    return { error: '无权操作：只有管理员或负责人可以标记卡住' };
  }

  // 使用状态机转换（带校验，blockedReason 会自动格式化为 notes）
  const result = await transitionMilestoneStatus(milestoneId, '阻塞', blockedReason);
  
  if (result.error || !result.data) {
    return { error: result.error || '节点状态更新失败，请重试' };
  }
  
  const updatedMilestone = result.data;
  const milestoneData = milestone as any;

  // Customer Memory V1: repeated_blocked — count blocked milestones for this customer
  const { data: orderRow } = await (supabase.from('orders') as any)
    .select('customer_name')
    .eq('id', milestoneData.order_id)
    .single();
  const customerName = (orderRow?.customer_name as string) || '';
  if (customerName) {
    const { data: ordersOfCustomer } = await (supabase.from('orders') as any)
      .select('id')
      .eq('customer_name', customerName);
    const orderIds = (ordersOfCustomer || []).map((o: any) => o.id);
    if (orderIds.length > 0) {
      const { count } = await (supabase.from('milestones') as any)
        .select('*', { count: 'exact', head: true })
        .in('order_id', orderIds)
        .eq('status', '阻塞');
      if (count != null && count >= 2) {
        await (supabase.from('customer_memory') as any).insert({
          customer_id: customerName,
          order_id: milestoneData.order_id,
          source_type: 'repeated_blocked',
          content: `该客户已有 ${count} 个控制点处于阻塞状态。本次: ${blockedReason}`.slice(0, 2000),
          category: 'general',
          risk_level: 'high',
          created_by: user.id,
        });
      }
    }
  }
  
  // Send blocked notification
  const { sendBlockedNotification } = await import('@/app/actions/notifications');
  await sendBlockedNotification(milestoneId, milestoneData.order_id, blockedReason);
  
  revalidatePath(`/orders/${milestoneData.order_id}`);
  revalidatePath('/dashboard');
  revalidatePath('/orders');
  
  return { data: updatedMilestone };
}

async function autoAdvanceNextMilestone(supabase: any, orderId: string) {
  // 按时间顺序推进：找到所有「未开始」且截止日期 ≤ 当前最早未完成节点的里程碑
  // 这样各阶段可以并行工作，不会被阶段顺序锁死
  const { data: pendingMilestones } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('order_id', orderId)
    .eq('status', 'pending') // DB stores English enum
    .order('due_at', { ascending: true });

  if (pendingMilestones && pendingMilestones.length > 0) {
    // 推进第一个（按截止日期最早的）
    await transitionMilestoneStatus(
      pendingMilestones[0].id,
      '进行中',
      '自动推进：上一节点已完成'
    );
  }
}

export async function updateMilestoneStatus(
  milestoneId: string,
  status: MilestoneStatus | string,
  note?: string
) {
  // 标准化状态
  const normalizedStatus = normalizeMilestoneStatus(status);
  
  // 重定向到专用函数
  if (normalizedStatus === '已完成') {
    return markMilestoneDone(milestoneId);
  } else if (normalizedStatus === '阻塞') {
    if (!note) {
      return { error: '请填写阻塞说明' };
    }
    return markMilestoneBlocked(milestoneId, note);
  }
  
  // 其他状态使用状态机转换
  const result = await transitionMilestoneStatus(milestoneId, normalizedStatus, note || null);
  
  if (result.error || !result.data) {
    return { error: result.error || '节点状态更新失败，请重试' };
  }
  
  const supabase = await createClient();
  const { data: milestone } = await (supabase
    .from('milestones') as any)
    .select('order_id')
    .eq('id', milestoneId)
    .single();
  
  if (milestone) {
    revalidatePath(`/orders/${(milestone as any).order_id}`);
    revalidatePath('/dashboard');
  }
  
  return { data: result.data };
}

// Legacy function - now handled by autoAdvanceNextMilestone
async function advanceToNextMilestone(orderId: string, currentStepKey: string) {
  const supabase = await createClient();
  await autoAdvanceNextMilestone(supabase, orderId);
}

export async function blockMilestone(milestoneId: string, reason: string, note: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  if (!reason || !note) {
    return { error: '请填写阻塞原因和说明' };
  }
  
  return updateMilestoneStatus(milestoneId, '阻塞', `${reason}: ${note}`);
}

export async function assignMilestoneOwner(milestoneId: string, userId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // Check if user is admin (multi-role safe)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  if (!userRoles.includes('admin')) {
    return { error: '只有管理员可以指定执行人' };
  }
  
  // 使用 repository 更新
  const result = await updateMilestone(milestoneId, { owner_user_id: userId });
  
  if (result.error || !result.data) {
    return { error: result.error || '节点状态更新失败，请重试' };
  }
  
  const milestone = result.data;
  const milestoneData = milestone as any;
  
  revalidatePath('/dashboard');
  revalidatePath(`/orders/${milestoneData.order_id}`);
  
  return { data: milestone };
}

export async function markMilestoneUnblocked(milestoneId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }

  // Only admin can unblock milestones (multi-role safe)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!userRoles.includes('admin')) {
    return { error: '无权操作：只有管理员可以解除卡住状态' };
  }

  // 使用状态机转换（卡住 -> 进行中）
  const result = await transitionMilestoneStatus(milestoneId, '进行中', '已解除阻塞');
  
  if (result.error || !result.data) {
    return { error: result.error || 'Failed to unblock milestone' };
  }
  
  const milestone = result.data;
  const milestoneData = milestone as any;
  
  revalidatePath('/dashboard');
  revalidatePath(`/orders/${milestoneData.order_id}`);
  
  return { data: milestone };
}

export async function getMilestoneLogs(milestoneId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: '请先登录' };
  }
  
  const { data: logs, error } = await supabase
    .from('milestone_logs')
    .select('*')
    .eq('milestone_id', milestoneId)
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message };
  }

  // 关联操作人名称
  if (logs && logs.length > 0) {
    const actorIds = [...new Set(logs.map((l: any) => l.actor_user_id).filter(Boolean))];
    if (actorIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, email')
        .in('user_id', actorIds);
      const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '未知']));
      for (const log of logs as any[]) {
        log.actor_name = log.actor_user_id ? (profileMap.get(log.actor_user_id) || '未知') : '系统';
      }
    }
  }

  return { data: logs };
}

/** Customer memory category/risk for manual execution notes (V1.1 includes trade-domain categories) */
type MemCategory = 'delay' | 'quality' | 'logistics' | 'general' | 'fabric_quality' | 'packaging' | 'plus_size_stretch';
type MemRisk = 'low' | 'medium' | 'high';

/**
 * Add execution note (milestone_log). Optionally save as customer memory.
 */
export async function addExecutionNote(
  milestoneId: string,
  note: string,
  saveAsCustomerMemory: boolean,
  category?: MemCategory,
  riskLevel?: MemRisk
): Promise<{ data?: unknown; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!note || !note.trim()) return { error: '备注不能为空' };

  const { data: milestone } = await (supabase.from('milestones') as any)
    .select('order_id')
    .eq('id', milestoneId)
    .single();
  if (!milestone) return { error: '找不到该执行节点' };
  const orderId = (milestone as any).order_id;

  await logMilestoneAction(supabase, milestoneId, orderId, 'execution_note', note.trim());

  if (saveAsCustomerMemory) {
    const { data: orderRow } = await (supabase.from('orders') as any)
      .select('customer_name')
      .eq('id', orderId)
      .single();
    const customerName = (orderRow?.customer_name as string) || '';
    if (customerName) {
      const { createCustomerMemory } = await import('@/app/actions/customer-memory');
      const req = classifyRequirement(note.trim());
      await createCustomerMemory({
        customer_id: customerName,
        order_id: orderId,
        source_type: 'manual',
        content: note.trim().slice(0, 2000),
        category: category ?? 'general',
        risk_level: riskLevel ?? 'medium',
        content_json: {
          requirement_type: req.type,
          keywords_hit: req.keywordsHit,
          excerpt: req.excerpt,
          milestone_id: milestoneId,
        },
      });
    }
  }

  revalidatePath(`/orders/${orderId}`);
  return { data: {} };
}

/**
 * Log evidence upload action
 */
export async function logEvidenceUpload(milestoneId: string, orderId: string, fileName: string) {
  const supabase = await createClient();
  await logMilestoneAction(supabase, milestoneId, orderId, 'upload_evidence', `已上传凭证：${fileName}`);
}

/** 允许用户填写 actual_at 的节点 */
const ACTUAL_DATE_EDITABLE_KEYS = [
  'materials_received_inspected',
  'production_kickoff',
  'factory_completion',
];

/**
 * 更新里程碑实际/预计完成日期（actual_at）
 * 仅限关键生产节点，用于交期预警
 */
export async function updateMilestoneActualDate(
  milestoneId: string,
  actualAt: string | null
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 查询节点信息（用 limit(1) 防止重复行导致 single() 报错）
  const { data: milestoneArr, error: getErr } = await (supabase
    .from('milestones') as any)
    .select('id, order_id, step_key, name, due_at, owner_role')
    .eq('id', milestoneId)
    .limit(1);
  const milestone = milestoneArr?.[0];
  if (getErr || !milestone) return { error: '找不到该节点' };

  // 校验：只有指定节点允许填写
  if (!ACTUAL_DATE_EDITABLE_KEYS.includes(milestone.step_key)) {
    return { error: `「${milestone.name}」不允许填写实际日期` };
  }

  // 更新 actual_at（不用 .single() 防止多行报错）
  const { error: updateErr } = await (supabase
    .from('milestones') as any)
    .update({ actual_at: actualAt })
    .eq('id', milestoneId);
  if (updateErr) return { error: `更新失败：${updateErr.message}` };

  // 记录日志
  const dateStr = actualAt ? new Date(actualAt).toLocaleDateString('zh-CN') : '已清除';
  await logMilestoneAction(
    supabase, milestoneId, milestone.order_id, 'update',
    `实际/预计日期更新为：${dateStr}`
  );

  // ===== 动态调整后续节点排期 =====
  if (actualAt) {
    const actualDate = new Date(actualAt + 'T00:00:00');
    const stepKey = milestone.step_key;

    // 原辅料到货 → 影响生产启动排期（到货后 +1 工作日）
    if (stepKey === 'materials_received_inspected') {
      const newKickoff = addWorkingDays(actualDate, 1);
      await (supabase.from('milestones') as any)
        .update({ due_at: ensureBusinessDay(newKickoff).toISOString() })
        .eq('order_id', milestone.order_id)
        .eq('step_key', 'production_kickoff');
    }
    // 生产启动 → 影响中查（+10工作日）、尾查、工厂完成
    if (stepKey === 'production_kickoff') {
      const midQc = addWorkingDays(actualDate, 10);
      await (supabase.from('milestones') as any)
        .update({ due_at: ensureBusinessDay(midQc).toISOString() })
        .eq('order_id', milestone.order_id)
        .eq('step_key', 'mid_qc_check');
    }
    // 工厂完成 → 影响验货/放行（+1工作日）
    if (stepKey === 'factory_completion') {
      const inspection = addWorkingDays(actualDate, 1);
      await (supabase.from('milestones') as any)
        .update({ due_at: ensureBusinessDay(inspection).toISOString() })
        .eq('order_id', milestone.order_id)
        .eq('step_key', 'inspection_release');
    }
  }

  // 交期预警：actual_at 超 due_at 3天以上触发 RED 邮件
  if (actualAt && milestone.due_at) {
    const diffMs = new Date(actualAt).getTime() - new Date(milestone.due_at).getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays > 3) {
      try {
        const { sendDeliveryDelayAlert } = await import('@/app/actions/notifications');
        await sendDeliveryDelayAlert(milestoneId, milestone.order_id, diffDays);
      } catch (e) {
        console.warn('[actual_at] 预警邮件发送失败:', e);
      }
    }
  }

  revalidatePath(`/orders/${milestone.order_id}`);
  revalidatePath('/orders');
  revalidatePath('/dashboard');

  return { data: { id: milestoneId, actual_at: actualAt } };
}

/**
 * Update milestone owner_user_id (admin only)
 */
export async function updateMilestoneOwner(
  milestoneId: string,
  ownerUserId: string | null
): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { error: '请先登录' };
  }
  
  // Check if user is admin (multi-role safe)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!userRoles.includes('admin')) {
    return { error: '只有管理员可以指定执行人' };
  }

  // Get milestone to get order_id for logging
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('order_id, name')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || '找不到该执行节点' };
  }
  
  // Update owner_user_id
  const { data: updated, error: updateError } = await (supabase
    .from('milestones') as any)
    .update({ owner_user_id: ownerUserId })
    .eq('id', milestoneId)
    .select()
    .single();
  
  if (updateError) {
    return { error: updateError.message };
  }
  
  // Log the action
  const ownerInfo = ownerUserId ? `已指派至：${ownerUserId}` : '已取消指派';
  await logMilestoneAction(
    supabase,
    milestoneId,
    milestone.order_id,
    'update',
    `执行人变更：${ownerInfo}`
  );
  
  revalidatePath('/orders');
  revalidatePath(`/orders/${milestone.order_id}`);
  
  return { data: updated };
}
