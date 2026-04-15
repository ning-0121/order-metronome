'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { calcDueDates } from '@/lib/schedule';
import { MANAGER_CC_EMAILS, escapeHtml } from '@/lib/utils/notifications';
import { updateMilestone, updateMilestones } from '@/lib/repositories/milestonesRepo';
import { sendEmailNotification } from '@/lib/utils/notifications';
import { isBlockedStatus } from '@/lib/domain/types';

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
  reasonType: string,
  reasonDetail: string,
  proposedNewAnchorDate?: string,
  proposedNewDueAt?: string,
  requiresCustomerApproval: boolean = false,
  customerApprovalEvidenceUrl?: string,
  reasonCategory?: 'customer' | 'supplier' | 'internal' | 'force_majeure'
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
  
  // 防重复：同一 milestone 不允许有多条 pending 延期请求
  const { data: existingPending } = await (supabase.from('delay_requests') as any)
    .select('id')
    .eq('milestone_id', milestoneId)
    .eq('status', 'pending')
    .limit(1);
  if (existingPending && existingPending.length > 0) {
    return { error: '该节点已有待审批的延期申请，请等待审批后再提交' };
  }

  // 使用延期规则引擎校验
  const { validateDelayRequest, DELAY_CATEGORIES } = await import('@/lib/domain/delay-rules');
  const category = reasonCategory || 'internal';
  const categoryInfo = DELAY_CATEGORIES[category];

  if (proposedNewDueAt && milestoneData.due_at) {
    const validation = validateDelayRequest({
      stepKey: milestoneData.step_key,
      category,
      currentDueAt: milestoneData.due_at,
      proposedDueAt: proposedNewDueAt,
    });
    if (!validation.allowed) {
      return { error: validation.reason };
    }
  }

  // 计算延期天数
  let delayDays = 0;
  if (proposedNewDueAt && milestoneData.due_at) {
    delayDays = Math.ceil(
      (new Date(proposedNewDueAt).getTime() - new Date(milestoneData.due_at).getTime()) / 86400000
    );
  } else if (proposedNewAnchorDate) {
    const oldAnchor = orderData.incoterm === 'FOB' ? orderData.etd : orderData.warehouse_due_date;
    if (oldAnchor) {
      delayDays = Math.ceil(
        (new Date(proposedNewAnchorDate).getTime() - new Date(oldAnchor).getTime()) / 86400000
      );
    }
  }

  // Create delay request
  const insertPayload: any = {
    order_id: orderData.id,
    milestone_id: milestoneId,
    requested_by: user.id,
    reason_type: reasonType,
    reason_category: category,
    reason_detail: reasonDetail,
    proposed_new_anchor_date: proposedNewAnchorDate || null,
    proposed_new_due_at: proposedNewDueAt || null,
    requires_customer_approval: requiresCustomerApproval,
    delay_days: delayDays,
    impacts_final_delivery: categoryInfo.impactsFinalDeliveryDate,
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
  
  // 获取申请人信息
  const { data: requesterProfile } = await (supabase.from('profiles') as any)
    .select('name, email, role, roles').eq('user_id', user.id).single();
  const requesterName = requesterProfile?.name || user.email?.split('@')[0] || '员工';
  const requesterRoles = (requesterProfile as any)?.roles?.length > 0
    ? (requesterProfile as any).roles
    : [(requesterProfile as any)?.role].filter(Boolean);
  const requesterRoleLabel = requesterRoles.length > 0
    ? requesterRoles.map((r: string) => ({
        sales: '业务', merchandiser: '跟单', finance: '财务',
        procurement: '采购', production: '生产', qc: 'QC',
        logistics: '物流', admin: '管理员'
      } as any)[r] || r).join('/')
    : '员工';

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
  const ccEmails = MANAGER_CC_EMAILS;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com';
  const orderLink = `${appUrl}/orders/${orderData.id}?tab=delays&from=/ceo`;
  const approvalLink = `${appUrl}/ceo#delay-approvals`;

  const subject = `[延期申请] ${requesterName} 申请延期 — ${orderData.order_no} · ${milestoneData.name}`;
  const body = `
    <div style="font-family: -apple-system, 'PingFang SC', sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: white; margin: 0; font-size: 22px;">⏳ 延期申请待审批</h2>
        <p style="color: #fef3c7; margin: 8px 0 0; font-size: 14px;">请尽快登录系统审批处理</p>
      </div>

      <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="background: #fef3c7; border-left: 4px solid #d97706; padding: 12px 16px; border-radius: 4px; margin-bottom: 20px;">
          <p style="margin: 0; color: #92400e; font-size: 14px;">
            <strong>👤 申请人：</strong>${requesterName}（${requesterRoleLabel}）<br>
            <strong>📧 邮箱：</strong>${user.email || '—'}
          </p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            <td style="padding: 8px 0; color: #6b7280; width: 100px;">订单号</td>
            <td style="padding: 8px 0; font-weight: 600; color: #111827;">
              <a href="${orderLink}" style="color: #4f46e5; text-decoration: none;">${orderData.order_no}</a>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">客户</td>
            <td style="padding: 8px 0; font-weight: 600; color: #111827;">${orderData.customer_name || '—'}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">申请节点</td>
            <td style="padding: 8px 0; font-weight: 600; color: #dc2626;">${milestoneData.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">延期原因</td>
            <td style="padding: 8px 0; color: #111827;">
              <span style="display: inline-block; background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 4px; font-size: 12px;">${reasonType}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; vertical-align: top;">详细说明</td>
            <td style="padding: 8px 0; color: #111827; line-height: 1.6;">${escapeHtml(reasonDetail || '无')}</td>
          </tr>
          ${proposedNewAnchorDate ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">新 Anchor</td>
            <td style="padding: 8px 0; color: #111827;">${proposedNewAnchorDate}</td>
          </tr>` : ''}
          ${proposedNewDueAt ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">新截止日期</td>
            <td style="padding: 8px 0; color: #111827; font-weight: 600;">${proposedNewDueAt}</td>
          </tr>` : ''}
        </table>

        <div style="display: flex; gap: 10px; margin-top: 24px;">
          <a href="${orderLink}" style="flex: 1; display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; text-align: center;">
            📋 查看订单详情
          </a>
          <a href="${approvalLink}" style="flex: 1; display: inline-block; background: #d97706; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; text-align: center;">
            ✅ 去审批处理
          </a>
        </div>

        <p style="color: #9ca3af; font-size: 12px; margin-top: 20px; margin-bottom: 0; text-align: center;">
          绮陌服饰智能系统 · 延期申请自动通知
        </p>
      </div>
    </div>
  `;

  await sendEmailNotification([recipientEmail, ...ccEmails], subject, body);

  // 管理员：系统内通知 + 企业微信推送
  const { data: admins } = await (supabase.from('profiles') as any)
    .select('user_id').or("role.eq.admin,roles.cs.{admin}");
  const adminUserIds: string[] = [];
  for (const admin of admins || []) {
    await (supabase.from('notifications') as any).insert({
      user_id: admin.user_id,
      type: 'delay_request',
      title: `${requesterName}（${requesterRoleLabel}）申请延期：${milestoneData.name}`,
      message: `订单 ${orderData.order_no}（${orderData.customer_name || '—'}）的「${milestoneData.name}」申请延期\n原因：${reasonDetail.slice(0, 100)}`,
      related_order_id: orderData.id,
      related_milestone_id: milestoneId,
      status: 'unread',
    });
    adminUserIds.push(admin.user_id);
  }

  // 企业微信推送管理员
  if (adminUserIds.length > 0) {
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      const wecomTitle = `⏳ ${requesterName} 申请延期`;
      const wecomContent = `订单：${orderData.order_no}（${orderData.customer_name || '—'}）\n节点：${milestoneData.name}\n原因：${reasonType}\n说明：${reasonDetail.slice(0, 100)}\n\n点击查看详情：${orderLink}`;
      await pushToUsers(supabase, adminUserIds, wecomTitle, wecomContent);
    } catch {}
  }

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/admin');

  return { data: delayRequest };
}

export async function approveDelayRequest(delayRequestId: string, decisionNote?: string) {
  try {
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
    return { error: `该延期申请已${delayRequestData.status === 'approved' ? '批准' : '处理'}，请刷新页面` };
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

  // 🔓 关键修复：批准延期后自动解除阻塞状态，恢复为"进行中"
  // 这样节点就不再显示为阻塞/逾期
  const wasBlocked = isBlockedStatus(milestoneData.status);
  const { notes: oldNotes } = milestoneData;
  const unblockNote = wasBlocked
    ? `[${new Date().toISOString().slice(0, 10)}] 延期批准，自动解除阻塞`
    : null;
  const newNotes = unblockNote
    ? (oldNotes ? `${oldNotes}\n${unblockNote}` : unblockNote)
    : oldNotes;

  await (supabase.from('milestones') as any)
    .update({
      status: 'in_progress',  // 英文 enum
      notes: newNotes,
    })
    .eq('id', milestoneData.id);

  if (wasBlocked) {
    await logMilestoneAction(
      supabase,
      milestoneData.id,
      orderData.id,
      'unblock',
      '延期批准，自动解除阻塞',
      {}
    );
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
  const ccEmails = MANAGER_CC_EMAILS;

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
    });
  }

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/admin');
  revalidatePath('/dashboard');
  revalidatePath('/');

  return { data: updatedRequest };
  } catch (err: any) {
    console.error('[approveDelayRequest] 异常:', err?.message);
    return { error: `审批异常：${err?.message || '未知错误'}` };
  }
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
    });

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
  revalidatePath('/dashboard');
  revalidatePath('/');

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
  const category = delayRequest.reason_category || 'internal';
  const impactsDelivery = delayRequest.impacts_final_delivery;

  // 无论内部/客户原因，延期批准后都要顺延下游节点
  // 区别只在于是否更新订单 anchor date（出厂日/ETD）

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

    // Recalculate all milestones（需要锚点日期，缺少时跳过全量重算）
    const newEtd = orderData.incoterm === 'FOB' ? delayRequest.proposed_new_anchor_date : orderData.etd;
    const newWh = orderData.incoterm === 'DDP' ? delayRequest.proposed_new_anchor_date : orderData.warehouse_due_date;
    const anchorAvailable = !!(newEtd || newWh || orderData.factory_date);

    if (!anchorAvailable) {
      // 缺少锚点：只更新当前节点的 due_at，不做全量重算
      if (delayRequest.proposed_new_due_at) {
        await supabase.from('milestones').update({ due_at: delayRequest.proposed_new_due_at }).eq('id', milestoneData.id);
      }
      return;
    }

    const createdAt = new Date(orderData.created_at);
    const scheduleEtd = newEtd || orderData.factory_date; // FOB/RMB 用出厂日期兜底
    const dueMap = calcDueDates({
      createdAt,
      incoterm: orderData.incoterm as 'FOB' | 'DDP',
      etd: scheduleEtd,
      warehouseDueDate: newWh,
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
    const newEtd = orderData.incoterm === 'FOB' ? delayRequestData.proposed_new_anchor_date : orderData.etd;
    const newWh = orderData.incoterm === 'DDP' ? delayRequestData.proposed_new_anchor_date : orderData.warehouse_due_date;
    const scheduleEtd = newEtd || orderData.factory_date;
    if (!scheduleEtd && !newWh) {
      // 缺少锚点日期，无法预览全量重算
      return { data: null, impactedMilestones: [], error: '订单缺少出厂日期/ETD，无法预览排期影响' };
    }
    const createdAt = new Date(orderData.created_at);
    const { calcDueDates } = await import('@/lib/schedule');
    const dueMap = calcDueDates({
      createdAt,
      incoterm: orderData.incoterm as 'FOB' | 'DDP',
      etd: scheduleEtd,
      warehouseDueDate: newWh,
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

  // 用 milestone 别名（单数）便于 UI 读取
  const { data: requests, error } = await (supabase
    .from('delay_requests') as any)
    .select(`
      *,
      milestone:milestones!inner(
        id,
        name,
        due_at,
        status
      )
    `)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message };
  }

  return { data: requests };
}
