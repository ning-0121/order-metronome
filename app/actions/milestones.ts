'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { isOverdue } from '@/lib/utils/date';
import {
  updateMilestone,
  createMilestone,
  transitionMilestoneStatus,
} from '@/lib/repositories/milestonesRepo';
import { normalizeMilestoneStatus } from '@/lib/domain/types';
import type { MilestoneStatus } from '@/lib/types';

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
  | 'update';

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
    return { error: 'Unauthorized' };
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
    const { data: profiles } = await (supabase
      .from('profiles') as any)
      .select('user_id, email, full_name, role')
      .in('user_id', ownerUserIds);
    
    if (profiles) {
      userMap = profiles.reduce((acc: Record<string, any>, profile: any) => {
        acc[profile.user_id] = profile;
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
    return { error: 'Unauthorized' };
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
    return { error: 'Unauthorized' };
  }
  
  // Get current milestone (for order_id and evidence_required)
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('order_id, evidence_required')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || 'Milestone not found' };
  }
  
  // Check if evidence is required and exists
  if (milestone.evidence_required) {
    const { data: attachments, error: attachmentsError } = await supabase
      .from('attachments')
      .select('id')
      .eq('milestone_id', milestoneId)
      .limit(1);
    
    if (attachmentsError) {
      return { error: `Failed to check evidence: ${attachmentsError.message}` };
    }
    
    if (!attachments || attachments.length === 0) {
      return { error: 'Evidence is required. Please upload at least one file before marking this milestone as done.' };
    }
  }
  
  // 使用状态机转换（带校验）
  const result = await transitionMilestoneStatus(milestoneId, '已完成', null);
  
  if (result.error || !result.data) {
    return { error: result.error || 'Failed to update milestone' };
  }
  
  const updatedMilestone = result.data;
  const milestoneData = milestone as any;
  
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
    return { error: 'Unauthorized' };
  }
  
  if (!blockedReason || blockedReason.trim() === '') {
    return { error: 'Blocked reason is required' };
  }
  
  // Get current milestone (for order_id)
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('order_id')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || 'Milestone not found' };
  }
  
  // 使用状态机转换（带校验，blockedReason 会自动格式化为 notes）
  const result = await transitionMilestoneStatus(milestoneId, '卡住', blockedReason);
  
  if (result.error || !result.data) {
    return { error: result.error || 'Failed to update milestone' };
  }
  
  const updatedMilestone = result.data;
  const milestoneData = milestone as any;
  
  // Send blocked notification
  const { sendBlockedNotification } = await import('@/app/actions/notifications');
  await sendBlockedNotification(milestoneId, milestoneData.order_id, blockedReason);
  
  revalidatePath(`/orders/${milestoneData.order_id}`);
  revalidatePath('/dashboard');
  revalidatePath('/orders');
  
  return { data: updatedMilestone };
}

async function autoAdvanceNextMilestone(supabase: any, orderId: string) {
  // Find the earliest milestone with status='未开始' for same order
  const { data: nextMilestone } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('order_id', orderId)
    .eq('status', '未开始') // 只查找中文状态
    .order('due_at', { ascending: true })
    .limit(1)
    .single();
  
  if (nextMilestone) {
    // 使用状态机转换（带校验）
    await transitionMilestoneStatus(
      nextMilestone.id,
      '进行中',
      '自动推进：上一个里程碑已完成'
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
  } else if (normalizedStatus === '卡住') {
    if (!note) {
      return { error: '卡住原因不能为空' };
    }
    return markMilestoneBlocked(milestoneId, note);
  }
  
  // 其他状态使用状态机转换
  const result = await transitionMilestoneStatus(milestoneId, normalizedStatus, note || null);
  
  if (result.error || !result.data) {
    return { error: result.error || 'Failed to update milestone' };
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
    return { error: 'Unauthorized' };
  }
  
  if (!reason || !note) {
    return { error: 'Reason and note are required when blocking a milestone' };
  }
  
  return updateMilestoneStatus(milestoneId, '卡住', `${reason}: ${note}`);
}

export async function assignMilestoneOwner(milestoneId: string, userId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized' };
  }
  
  // Check if user is admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();
  
  if (!profile || (profile as any).role !== 'admin') {
    return { error: 'Only admins can assign milestone owners' };
  }
  
  // 使用 repository 更新
  const result = await updateMilestone(milestoneId, { owner_user_id: userId });
  
  if (result.error || !result.data) {
    return { error: result.error || 'Failed to update milestone' };
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
    return { error: 'Unauthorized' };
  }
  
  // 使用状态机转换（卡住 -> 进行中）
  const result = await transitionMilestoneStatus(milestoneId, '进行中', '已解除卡住状态');
  
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
    return { error: 'Unauthorized' };
  }
  
  const { data: logs, error } = await supabase
    .from('milestone_logs')
    .select('*')
    .eq('milestone_id', milestoneId)
    .order('created_at', { ascending: false });
  
  if (error) {
    return { error: error.message };
  }
  
  return { data: logs };
}

/**
 * Log evidence upload action
 */
export async function logEvidenceUpload(milestoneId: string, orderId: string, fileName: string) {
  const supabase = await createClient();
  await logMilestoneAction(supabase, milestoneId, orderId, 'upload_evidence', `Uploaded evidence: ${fileName}`);
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
    return { error: 'Unauthorized' };
  }
  
  // Check if user is admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();
  
  const isAdmin = profile && (profile as any).role === 'admin';
  if (!isAdmin) {
    return { error: 'Only admin can assign milestone owners' };
  }
  
  // Get milestone to get order_id for logging
  const { data: milestone, error: getError } = await (supabase
    .from('milestones') as any)
    .select('order_id, name')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || 'Milestone not found' };
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
  const ownerInfo = ownerUserId ? `Assigned to user: ${ownerUserId}` : 'Unassigned';
  await logMilestoneAction(
    supabase,
    milestoneId,
    milestone.order_id,
    'update',
    `Owner assignment: ${ownerInfo}`
  );
  
  revalidatePath('/orders');
  revalidatePath(`/orders/${milestone.order_id}`);
  
  return { data: updated };
}
