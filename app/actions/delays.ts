'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { calcDueDates } from '@/lib/schedule';
import { updateMilestone, updateMilestones } from '@/lib/repositories/milestonesRepo';
import { sendEmailNotification } from '@/lib/utils/notifications';

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
  | 'upload_evidence';

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

type DelayReasonType =
  | 'customer_confirmation'
  | 'supplier_delay'
  | 'internal_delay'
  | 'logistics'
  | 'force_majeure'
  | 'other';

export async function createDelayRequest(
  milestoneId: string,
  reasonType: DelayReasonType,
  reasonDetail: string,
  proposedNewAnchorDate?: string,
  proposedNewDueAt?: string,
  requiresCustomerApproval: boolean = false,
  customerApprovalEvidenceUrl?: string
) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized' };
  }

  // Get milestone
  const { data: milestone } = await supabase
    .from('milestones')
    .select('*')
    .eq('id', milestoneId)
    .single();
  
  if (!milestone) {
    return { error: 'Milestone not found' };
  }

  // 生命周期校验：已完成/已取消的订单不能申请延期
  const { data: orderCheck } = await (supabase.from('orders') as any)
    .select('lifecycle_status').eq('id', (milestone as any).order_id).single();
  if (orderCheck) {
    const ls = orderCheck.lifecycle_status;
    if (ls === 'completed' || ls === '已完成') return { error: '该订单已完成，不能申请延期' };
    if (ls === 'cancelled' || ls === '已取消') return { error: '该订单已取消，不能申请延期' };
  }

  // Get order separately
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', (milestone as any).order_id)
    .single();
  
  if (!order) {
    return { error: 'Order not found' };
  }
  
  const orderData = order as any;
  const milestoneData = milestone as any;

  // 权限：仅关卡对应角色或指定负责人可申请延期（管理员不能代替业务申请）
  const { data: delayProfile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const delayUserRoles: string[] = (delayProfile as any)?.roles?.length > 0 ? (delayProfile as any).roles : [(delayProfile as any)?.role].filter(Boolean);
  const isDelayAssigned = milestoneData.owner_user_id === user.id;
  const delayRoleMatch = milestoneData.owner_role && delayUserRoles.some(
    (r: string) => r.toLowerCase() === milestoneData.owner_role.toLowerCase()
      || (milestoneData.owner_role === 'sales' && r === 'merchandiser')
      || (milestoneData.owner_role === 'merchandiser' && r === 'sales')
  );
  if (!isDelayAssigned && !delayRoleMatch) {
    return { error: '仅该关卡对应角色的负责人可申请延期' };
  }

  // Validate: must provide either new anchor date or new due_at
  if (!proposedNewAnchorDate && !proposedNewDueAt) {
    return { error: 'Must provide either new anchor date or new due date' };
  }
  
  // Create delay request
  const insertPayload: any = {
    order_id: orderData.id,
    milestone_id: milestoneId,
    requested_by: user.id,
    reason_type: reasonType,
    reason_detail: reasonDetail,
    proposed_new_anchor_date: proposedNewAnchorDate || null,
    proposed_new_due_at: proposedNewDueAt || null,
    requires_customer_approval: requiresCustomerApproval,
    status: 'pending',
  };
  const { data: delayRequest, error } = await (supabase
    .from('delay_requests') as any)
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    return { error: error.message };
  }

  // Log action
  await logMilestoneAction(
    supabase,
    milestoneId,
    orderData.id,
    'request_delay',
    reasonDetail,
    { delay_request_id: (delayRequest as any).id }
  );

  // Customer Memory V1: auto-create on delay request
  const customerName = (orderData.customer_name as string) || '';
  if (customerName) {
    await (supabase.from('customer_memory') as any).insert({
      customer_id: customerName,
      order_id: orderData.id,
      source_type: 'delay_request',
      content: `[${reasonType}] ${reasonDetail}`.slice(0, 2000),
      category: 'delay',
      risk_level: 'medium',
      created_by: user.id,
    });
  }
  
  // Send email notification
  let recipientEmail = user.email || '';
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('user_id', orderData.created_by)
      .single();
    if (profile && (profile as any).email) recipientEmail = (profile as any).email;
  } catch (e) {
    // Use current user email as fallback
  }
  const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];

  const subject = `[Delay Request] Order ${orderData.order_no} - ${milestoneData.name}`;
  const body = `
    <h2>Delay Request Submitted</h2>
    <p><strong>Order:</strong> ${orderData.order_no}</p>
    <p><strong>Milestone:</strong> ${milestoneData.name}</p>
    <p><strong>Reason Type:</strong> ${reasonType}</p>
    <p><strong>Reason Detail:</strong> ${reasonDetail}</p>
    ${proposedNewAnchorDate ? `<p><strong>New Anchor Date:</strong> ${proposedNewAnchorDate}</p>` : ''}
    ${proposedNewDueAt ? `<p><strong>New Due Date:</strong> ${proposedNewDueAt}</p>` : ''}
    <p>Please review and approve/reject this delay request.</p>
  `;

  await sendEmailNotification([recipientEmail, ...ccEmails], subject, body);

  // 通知管理员铃铛：有延期申请待审批
  const { data: requesterProfile } = await (supabase.from('profiles') as any).select('name').eq('user_id', user.id).single();
  const requesterName = requesterProfile?.name || user.email?.split('@')[0] || '员工';
  const { data: admins } = await (supabase.from('profiles') as any)
    .select('user_id').or("role.eq.admin,roles.cs.{admin}");
  for (const admin of admins || []) {
    await (supabase.from('notifications') as any).insert({
      user_id: admin.user_id,
      type: 'delay_request',
      title: `${requesterName} 申请延期：${milestoneData.name}`,
      message: `订单 ${orderData.order_no} 的「${milestoneData.name}」申请延期，原因：${reasonDetail.slice(0, 100)}`,
      related_order_id: orderData.id,
      related_milestone_id: milestoneId,
      status: 'unread',
    }).catch(() => {});
  }

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/admin');

  return { data: delayRequest };
}

export async function approveDelayRequest(delayRequestId: string, decisionNote?: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized' };
  }

  // Get delay request
  const { data: delayRequest } = await supabase
    .from('delay_requests')
    .select('*')
    .eq('id', delayRequestId)
    .single();

  if (!delayRequest) {
    return { error: 'Delay request not found' };
  }

  const delayRequestData = delayRequest as any;

  if (delayRequestData.status !== 'pending') {
    return { error: 'Delay request already processed' };
  }

  // Get milestone and order separately
  const { data: milestone } = await supabase
    .from('milestones')
    .select('*')
    .eq('id', delayRequestData.milestone_id)
    .single();
  
  if (!milestone) {
    return { error: 'Milestone not found' };
  }
  
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', delayRequestData.order_id)
    .single();
  
  if (!order) {
    return { error: 'Order not found' };
  }

  const orderData = order as any;
  const milestoneData = milestone as any;

  // 权限：仅管理员可审批延期（审批权集中在管理层，避免自己审批自己）
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = userRoles.includes('admin');

  if (!isAdmin) {
    return { error: '无权操作：只有管理员可以审批延期申请' };
  }

  // Update delay request
  const updatePayload: any = {
    status: 'approved',
    approved_by: user.id,
    approved_at: new Date().toISOString(),
    decision_note: decisionNote || null,
  };
  const { data: updatedRequest, error: updateError } = await (supabase
    .from('delay_requests') as any)
    .update(updatePayload)
    .eq('id', delayRequestId)
    .select()
    .single();

  if (updateError) {
    return { error: updateError.message };
  }

  // Log action
  await logMilestoneAction(
    supabase,
    milestoneData.id,
    orderData.id,
    'approve_delay',
    decisionNote || 'Delay approved',
    { delay_request_id: delayRequestId }
  );

  // Customer Memory V1: auto-create on delay approval
  const customerName = (orderData.customer_name as string) || '';
  if (customerName) {
    await (supabase.from('customer_memory') as any).insert({
      customer_id: customerName,
      order_id: orderData.id,
      source_type: 'delay_approval',
      content: `延期已批准: ${milestoneData.name}. ${(decisionNote || '').slice(0, 500)}`.trim().slice(0, 2000),
      category: 'delay',
      risk_level: 'low',
      created_by: user.id,
    });
  }

  // Recalculate schedule
  await recalculateSchedule(supabase, orderData, milestoneData, delayRequestData);

  // Send approval email
  let recipientEmail = user.email || '';
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('user_id', orderData.created_by)
      .single();
    if (profile && (profile as any).email) recipientEmail = (profile as any).email;
  } catch (e) {
    // Use current user email as fallback
  }
  const ccEmails = ['su@qimoclothing.com', 'alex@qimoclothing.com'];

  const subject = `[Approved] Delay Request - Order ${orderData.order_no}`;
  const body = `
    <h2>Delay Request Approved</h2>
    <p><strong>Order:</strong> ${orderData.order_no}</p>
    <p><strong>Milestone:</strong> ${milestoneData.name}</p>
    <p><strong>Decision Note:</strong> ${decisionNote || 'Approved'}</p>
    <p>The schedule has been automatically recalculated.</p>
  `;

  await sendEmailNotification([recipientEmail, ...ccEmails], subject, body);

  // 通知申请人铃铛：延期已通过
  if (delayRequestData.requested_by) {
    await (supabase.from('notifications') as any).insert({
      user_id: delayRequestData.requested_by,
      type: 'delay_approved',
      title: `延期已通过：${milestoneData.name}`,
      message: `订单 ${orderData.order_no} 的「${milestoneData.name}」延期申请已通过${decisionNote ? '，备注：' + decisionNote : ''}`,
      related_order_id: orderData.id,
      related_milestone_id: delayRequestData.milestone_id,
      status: 'unread',
    }).catch(() => {});
  }

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/admin');

  return { data: updatedRequest };
}

export async function rejectDelayRequest(delayRequestId: string, decisionNote: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized' };
  }

  // Get delay request
  const { data: delayRequest } = await supabase
    .from('delay_requests')
    .select('*')
    .eq('id', delayRequestId)
    .single();

  if (!delayRequest) {
    return { error: 'Delay request not found' };
  }

  const delayRequestData = delayRequest as any;

  // Get order separately
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', delayRequestData.order_id)
    .single();
  
  if (!order) {
    return { error: 'Order not found' };
  }

  const orderData = order as any;

  // 权限：仅管理员可驳回延期（与审批一致，审批权集中在管理层）
  const { data: rejectProfile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const rejectUserRoles: string[] = (rejectProfile as any)?.roles?.length > 0 ? (rejectProfile as any).roles : [(rejectProfile as any)?.role].filter(Boolean);
  const isRejectAdmin = rejectUserRoles.includes('admin');

  if (!isRejectAdmin) {
    return { error: '无权操作：只有管理员可以驳回延期申请' };
  }

  // Update delay request
  const updatePayload: any = {
    status: 'rejected',
    approved_by: user.id,
    approved_at: new Date().toISOString(),
    decision_note: decisionNote,
  };
  const { data: updatedRequest, error } = await (supabase
    .from('delay_requests') as any)
    .update(updatePayload)
    .eq('id', delayRequestId)
    .select()
    .single();

  if (error) {
    return { error: error.message };
  }

  // Get milestone for logging
  const { data: milestone } = await supabase
    .from('milestones')
    .select('*')
    .eq('id', delayRequestData.milestone_id)
    .single();
  
  if (milestone) {
    const milestoneData = milestone as any;
    await logMilestoneAction(
      supabase,
      milestoneData.id,
      delayRequestData.order_id,
      'reject_delay',
      decisionNote,
      { delay_request_id: delayRequestId }
    );
  }

  // 通知申请人铃铛+邮件：延期被驳回
  if (delayRequestData.requested_by) {
    const milestoneData2 = milestone as any;
    await (supabase.from('notifications') as any).insert({
      user_id: delayRequestData.requested_by,
      type: 'delay_rejected',
      title: `延期被驳回：${milestoneData2?.name || ''}`,
      message: `订单 ${orderData.order_no} 的延期申请被驳回${decisionNote ? '，原因：' + decisionNote : ''}`,
      related_order_id: orderData.id,
      related_milestone_id: delayRequestData.milestone_id,
      status: 'unread',
    }).catch(() => {});

    // 驳回邮件
    const { data: reqProfile } = await (supabase.from('profiles') as any).select('email').eq('user_id', delayRequestData.requested_by).single();
    if (reqProfile?.email) {
      const { sendEmailNotification } = await import('@/lib/utils/notifications');
      await sendEmailNotification([reqProfile.email], `[驳回] ${orderData.order_no} 延期申请未通过`, `
        <h2>延期申请被驳回</h2>
        <p><strong>订单：</strong>${orderData.order_no}</p>
        <p><strong>节点：</strong>${milestoneData2?.name || ''}</p>
        <p><strong>驳回原因：</strong>${decisionNote || '未说明'}</p>
        <p>请根据原计划继续执行。</p>
      `).catch(() => {});
    }
  }

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/admin');

  return { data: updatedRequest };
}

async function recalculateSchedule(
  supabase: any,
  order: any,
  milestone: any,
  delayRequest: any
) {
  // 确保 milestone 和 order 是对象
  if (!milestone || !order) {
    console.error('recalculateSchedule: milestone or order is missing');
    return;
  }
  
  const orderData = order as any;
  const milestoneData = milestone as any;
  
  // If proposed_new_anchor_date is provided, update order and recalculate all milestones
  if (delayRequest.proposed_new_anchor_date) {
    const updates: any = {};
    if (orderData.incoterm === 'FOB') {
      updates.etd = delayRequest.proposed_new_anchor_date;
    } else {
      updates.warehouse_due_date = delayRequest.proposed_new_anchor_date;
    }

    await supabase
      .from('orders')
      .update(updates)
      .eq('id', orderData.id);

    // Recalculate all milestones
    const createdAt = new Date(orderData.created_at);
    const dueMap = calcDueDates({
      createdAt,
      incoterm: orderData.incoterm as 'FOB' | 'DDP',
      etd: orderData.incoterm === 'FOB' ? delayRequest.proposed_new_anchor_date : orderData.etd,
      warehouseDueDate: orderData.incoterm === 'DDP' ? delayRequest.proposed_new_anchor_date : orderData.warehouse_due_date,
    });

    // Get all milestones for this order
    const { data: allMilestones } = await supabase
      .from('milestones')
      .select('*')
      .eq('order_id', orderData.id);

    // 使用统一入口批量更新
    if (allMilestones) {
      const updates = allMilestones
        .map((m: any) => {
          const due = dueMap[m.step_key as keyof typeof dueMap];
          if (due) {
            return {
              id: m.id,
              patch: {
                planned_at: due.toISOString(),
                due_at: due.toISOString(),
              },
            };
          }
          return null;
        })
        .filter((u: any): u is { id: string; patch: Record<string, any> } => u !== null);
      
      if (updates.length > 0) {
        await updateMilestones(updates);
      }
    }

    // Log recalculation
    await logMilestoneAction(
      supabase,
      milestoneData.id,
      orderData.id,
      'recalc_schedule',
      'Schedule recalculated due to anchor date change',
      { new_anchor_date: delayRequest.proposed_new_anchor_date }
    );
  } else if (delayRequest.proposed_new_due_at) {
    // Update this milestone's due_at
    const oldDueAt = new Date(milestoneData.due_at);
    const newDueAt = new Date(delayRequest.proposed_new_due_at);
    const deltaDays = Math.round((newDueAt.getTime() - oldDueAt.getTime()) / (1000 * 60 * 60 * 24));

    // 使用统一入口更新当前里程碑
    await updateMilestone(milestoneData.id, {
      planned_at: delayRequest.proposed_new_due_at,
      due_at: delayRequest.proposed_new_due_at,
    });

    // Shift downstream milestones by same delta
    const { data: downstreamMilestones } = await supabase
      .from('milestones')
      .select('*')
      .eq('order_id', orderData.id)
      .gte('due_at', milestoneData.due_at)
      .neq('id', milestoneData.id);

    // 使用统一入口批量更新下游里程碑
    if (downstreamMilestones) {
      const updates = downstreamMilestones
        .map((m: any) => {
          if (m.due_at) {
            const currentDue = new Date(m.due_at);
            const newDue = new Date(currentDue.getTime() + deltaDays * 24 * 60 * 60 * 1000);
            return {
              id: m.id,
              patch: {
                due_at: newDue.toISOString(),
                planned_at: newDue.toISOString(),
              },
            };
          }
          return null;
        })
        .filter((u: any): u is { id: string; patch: Record<string, any> } => u !== null);
      
      if (updates.length > 0) {
        await updateMilestones(updates);
      }
    }

    // Log recalculation
    await logMilestoneAction(
      supabase,
      milestoneData.id,
      orderData.id,
      'recalc_schedule',
      `Schedule shifted by ${deltaDays} days`,
      { new_due_at: delayRequest.proposed_new_due_at }
    );
  }
}

/**
 * Get impacted downstream milestones for a delay request
 */
export async function getImpactedMilestones(delayRequestId: string) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized', data: null };
  }
  
  // Get delay request with milestone and order info
  const { data: delayRequest } = await (supabase
    .from('delay_requests') as any)
    .select('*, milestones!inner(id, order_id, due_at, step_key, name), orders!inner(id, incoterm, etd, warehouse_due_date, created_at)')
    .eq('id', delayRequestId)
    .single();
  
  if (!delayRequest) {
    return { error: 'Delay request not found', data: null };
  }
  
  const delayRequestData = delayRequest as any;
  const milestoneData = delayRequestData.milestones;
  const orderData = delayRequestData.orders;
  
  const impactedMilestones: Array<{
    id: string;
    name: string;
    step_key: string;
    current_due_at: string;
    new_due_at: string;
    delta_days: number;
  }> = [];
  
  // If anchor date change, all milestones are impacted
  if (delayRequestData.proposed_new_anchor_date) {
    const createdAt = new Date(orderData.created_at);
    const { calcDueDates } = await import('@/lib/schedule');
    const dueMap = calcDueDates({
      createdAt,
      incoterm: orderData.incoterm as 'FOB' | 'DDP',
      etd: orderData.incoterm === 'FOB' ? delayRequestData.proposed_new_anchor_date : orderData.etd,
      warehouseDueDate: orderData.incoterm === 'DDP' ? delayRequestData.proposed_new_anchor_date : orderData.warehouse_due_date,
    });
    
    // Get all milestones
    const { data: allMilestones } = await supabase
      .from('milestones')
      .select('id, name, step_key, due_at')
      .eq('order_id', orderData.id);
    
    if (allMilestones) {
      allMilestones.forEach((m: any) => {
        const newDue = dueMap[m.step_key as keyof typeof dueMap];
        if (newDue) {
          const currentDue = new Date(m.due_at);
          const deltaDays = Math.round((newDue.getTime() - currentDue.getTime()) / (1000 * 60 * 60 * 24));
          impactedMilestones.push({
            id: m.id,
            name: m.name,
            step_key: m.step_key,
            current_due_at: m.due_at,
            new_due_at: newDue.toISOString(),
            delta_days: deltaDays,
          });
        }
      });
    }
  } else if (delayRequestData.proposed_new_due_at) {
    // Single milestone change - get downstream milestones
    const oldDueAt = new Date(milestoneData.due_at);
    const newDueAt = new Date(delayRequestData.proposed_new_due_at);
    const deltaDays = Math.round((newDueAt.getTime() - oldDueAt.getTime()) / (1000 * 60 * 60 * 24));
    
    // Add the current milestone
    impactedMilestones.push({
      id: milestoneData.id,
      name: milestoneData.name,
      step_key: milestoneData.step_key,
      current_due_at: milestoneData.due_at,
      new_due_at: delayRequestData.proposed_new_due_at,
      delta_days: deltaDays,
    });
    
    // Get downstream milestones
    const { data: downstreamMilestones } = await supabase
      .from('milestones')
      .select('id, name, step_key, due_at')
      .eq('order_id', orderData.id)
      .gte('due_at', milestoneData.due_at)
      .neq('id', milestoneData.id);
    
    if (downstreamMilestones) {
      downstreamMilestones.forEach((m: any) => {
        const currentDue = new Date(m.due_at);
        const newDue = new Date(currentDue.getTime() + deltaDays * 24 * 60 * 60 * 1000);
        impactedMilestones.push({
          id: m.id,
          name: m.name,
          step_key: m.step_key,
          current_due_at: m.due_at,
          new_due_at: newDue.toISOString(),
          delta_days: deltaDays,
        });
      });
    }
  }
  
  return { data: impactedMilestones, error: null };
}

export async function getDelayRequestsByOrder(orderId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized' };
  }

  const { data: requests, error } = await (supabase
    .from('delay_requests') as any)
    .select(`
      *,
      milestones!inner(
        id,
        name,
        due_at
      )
    `)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message };
  }

  return { data: requests };
}
