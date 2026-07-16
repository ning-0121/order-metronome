'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { calcDueDates, compressRemainingIntoWindow, monotonicRepairDueDates } from '@/lib/schedule';
import { MANAGER_CC_EMAILS, escapeHtml } from '@/lib/utils/notifications';
// updateMilestone/updateMilestones 不再在 recalculateSchedule 中使用
// （系统级联操作直接走 supabase，避免 repo 层权限校验干扰）
import { sendEmailNotification } from '@/lib/utils/notifications';
import { isAdminRole, hasRoleInGroup } from '@/lib/domain/roles';
import { type ActionResult, success, failure, toLegacyResult } from '@/lib/types/action-result';
import { isBlockedStatus, isDoneStatus, isApprovalPending } from '@/lib/domain/types';
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
  reasonCategory?: 'customer' | 'supplier' | 'internal' | 'force_majeure',
  // 2026-07-09 用户拍板:延期强制二选一,下游必动。
  //   push_delivery = 顺延交期(交期+下游都后移 N 天) | hold_delivery = 保交期(交期不动,下游压缩)
  mode?: 'push_delivery' | 'hold_delivery',
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
    if (ls === 'paused' || ls === '已暂停') return { error: '该订单已暂停，不能申请延期' };
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

  // 计算延期天数(该节点新截止 − 原截止)
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

  // ── 二选一路由(mode 显式优先;缺省回退到 category)──
  // 顺延交期:新交期 = 原交期 + 延期天数(服务端算,绝不把"某个中间节点的新日期"当交期,修历史 bug)。
  // 保交期:不动交期,只带节点新日期,审批落地时把下游压进剩余窗口。
  let impactsFinalDelivery = categoryInfo.impactsFinalDeliveryDate;
  let rescheduleModeInit: 'push_delivery' | 'urgent' | null = null;
  if (mode === 'push_delivery') {
    const oldAnchor = orderData.incoterm === 'FOB' ? (orderData.etd || orderData.factory_date) : (orderData.warehouse_due_date || orderData.eta);
    if (oldAnchor && delayDays > 0) {
      const a = new Date(oldAnchor + 'T00:00:00+08:00');
      a.setDate(a.getDate() + delayDays);
      proposedNewAnchorDate = a.toISOString().slice(0, 10);
    }
    impactsFinalDelivery = true;
    rescheduleModeInit = 'push_delivery';
  } else if (mode === 'hold_delivery') {
    proposedNewAnchorDate = undefined;   // 保交期:绝不动锚点
    impactsFinalDelivery = false;
    rescheduleModeInit = 'urgent';
  }

  // 改期审批链快照(2026-07-05 P1):按该节点 owner_role 从路由表冻结审批链,逐级确认
  const { deferralChainFor } = await import('@/lib/domain/deferral-routing');
  const approvalChain = deferralChainFor(milestoneData.owner_role);
  // 生产内部排期由生产主管批准；只有改变客户承诺交期时才追加业务经理。
  if (String(milestoneData.owner_role).toLowerCase() === 'production' && impactsFinalDelivery && !approvalChain.includes('sales_manager')) {
    approvalChain.push('sales_manager');
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
    impacts_final_delivery: impactsFinalDelivery,
    reschedule_mode: rescheduleModeInit,
    status: 'pending',
    approval_chain: approvalChain,
    current_step: 0,
  };
  let { data: delayRequest, error } = await (supabase
    .from('delay_requests') as any)
    .insert(insertPayload)
    .select()
    .single();
  // 迁移未执行(缺 approval_chain 等列)→ 降级去掉链列重插,不 brick 申请
  if (error && /approval_chain|current_step|column .* does not exist/i.test(error.message || '')) {
    const { approval_chain, current_step, ...plain } = insertPayload;
    ({ data: delayRequest, error } = await (supabase.from('delay_requests') as any).insert(plain).select().single());
  }

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

  // 通知待审批(2026-07-11 修:原来只通知审批链首角色,业务执行的延期链首是 sales,经理 order_manager/
  //   sales_manager 收不到 → 打不通。改为链首 + 管理审批人(CAN_APPROVE_DELAY=admin/order_manager/sales_manager)全通知)
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    const targetRoles = Array.from(new Set([
      ...(approvalChain.length > 0 ? [approvalChain[0]] : []),
      'admin', 'order_manager', 'sales_manager',
    ]));
    await notifyUsersByRole(supabase, targetRoles, {
      type: 'deferral_approval',
      title: `🕒 改期待审批:${(milestoneData.name || '')}（${orderData.internal_order_no || orderData.order_no || ''}）`,
      message: `${milestoneData.name || '节点'}申请改期到 ${proposedNewDueAt || proposedNewAnchorDate || '新日期'}；原因：${reasonDetail}。请到该订单「延期」处审批。`,
      relatedOrderId: orderData.id,
    });
  } catch (e: any) { console.warn('[createDelayRequest] 待审批通知失败(不阻断):', e?.message); }

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
          QIMO OS · 延期申请自动通知
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
    } catch (e: any) { console.warn(`[delays] 延期申请次要操作 343:`, e?.message); }
  }

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/orders');
  revalidatePath('/admin');
  revalidatePath('/ceo');

  return { data: delayRequest };
}

/**
 * 审批延期申请
 *
 * Sprint 0 加固：返回类型保持 `{error?, data?}` 旧契约（前端兼容），
 * 但内部使用 ActionResult helpers 统一构造逻辑。
 *
 * 调用方（前端）：DelayRequestDetail / DelayRequestsList / DelayRequestActions
 * 期望形态：result.error → 报错；result.data → 成功
 */
export async function approveDelayRequest(delayRequestId: string, decisionNote?: string) {
  return toLegacyResult(await approveDelayRequestCore(delayRequestId, decisionNote));
}

/**
 * P1/P3 多级链审批(2026-07-05):当前轮到的角色确认一步。链满 → 复用 approveDelayRequestCore 落地。
 * P3:若此改期影响整体交期,链末位需选 mode —— push_delivery(退交期,推整体交期)/
 *     urgent(转紧急,不退交期、链追加采购+生产确认下游压缩、订单标「交期紧急」)。
 * 权限:调用者须持链上 current_step 那级的角色(admin 可代任一步)。
 */
export async function approveDeferralStep(delayRequestId: string, note?: string, mode?: 'push_delivery' | 'urgent'): Promise<{ ok?: boolean; done?: boolean; nextRole?: string; needsMode?: boolean; urgent?: boolean; error?: string }> {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (userClient.from('profiles') as any).select('role, roles, name').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);

  const { roleCn } = await import('@/lib/domain/deferral-routing');
  let svc: any; try { svc = createServiceRoleClient(); } catch { svc = userClient; }
  const { data: dr } = await (svc.from('delay_requests') as any)
    .select('id, order_id, status, approval_chain, approvals, current_step, reschedule_mode, impacts_final_delivery, requested_by').eq('id', delayRequestId).maybeSingle();
  if (!dr) return { error: '改期申请不存在' };
  if ((dr as any).status !== 'pending') return { error: '该申请已处理' };
  // 自批门禁 P2-12(2026-07-12):不能审批自己提交的改期(与 approveDelayRequestCore:564 同口径;admin 例外)。
  //   放在最前 → 也避免了"末位先写 current_step 再调 core、core 拒自批却不回滚"的脏态。
  if ((dr as any).requested_by === user.id && !roles.includes('admin')) {
    return { error: '不能审批自己提交的改期申请,请由他人(下游团队/管理员)确认' };
  }
  const chain: string[] = Array.isArray((dr as any).approval_chain) ? (dr as any).approval_chain : [];
  if (chain.length === 0) return { error: '该申请无审批链(旧单请走原审批入口)' };
  const step = Number((dr as any).current_step) || 0;
  const needRole = chain[step];
  // 2026-07-11:CAN_APPROVE_DELAY 经理(admin/order_manager/sales_manager)可代任一步确认(与 admin 同权)。
  //   否则业务执行(merchandiser)的延期链首是 sales,高洁(order_manager)角色不匹配 → 审批不了。
  const { canActOnDeferralStep } = await import('@/lib/domain/deferral-routing');
  if (!canActOnDeferralStep({ roles, requiredRole: needRole, actorId: user.id, requesterId: (dr as any).requested_by })) {
    return { error: `本步需「${roleCn(needRole)}」或业务经理确认,你的角色不匹配` };
  }

  const approvals = Array.isArray((dr as any).approvals) ? (dr as any).approvals : [];
  approvals.push({ role: needRole, user_id: user.id, name: (prof as any)?.name || null, at: new Date().toISOString(), note: note || null });
  const nextStep = step + 1;
  const baseComplete = nextStep >= chain.length;
  const alreadyDecided = !!(dr as any).reschedule_mode;   // 已定过 mode = 链已为 urgent 追加过采购/生产
  const impactsDelivery = !!(dr as any).impacts_final_delivery;

  const { notifyUsersByRole } = await import('@/lib/utils/notifications');
  const notify = async (role: string, msg: string) => {
    try { await notifyUsersByRole(svc, [role], { type: 'deferral_approval', title: '🕒 改期待你确认', message: msg, relatedOrderId: (dr as any).order_id }); } catch { /* 不阻断 */ }
  };

  if (baseComplete) {
    // P3:到链末位,且影响交期,且还没定 mode → 需要"退交期 / 转紧急"决策
    if (impactsDelivery && !alreadyDecided && !mode) {
      // 先不推进,让前端弹二选一(不写库,保持本步未确认)
      approvals.pop();
      return { needsMode: true, error: '此改期影响整体交期,请选择「退交期」或「转紧急」' };
    }
    if (impactsDelivery && !alreadyDecided && mode === 'urgent') {
      // 转紧急:链追加 采购+生产 确认下游压缩,标 reschedule_mode,暂不落地
      const ext = [...chain];
      for (const r of ['procurement', 'production']) if (!ext.includes(r)) ext.push(r);
      await (svc.from('delay_requests') as any)
        .update({ approvals, current_step: nextStep, approval_chain: ext, reschedule_mode: 'urgent', updated_at: new Date().toISOString() }).eq('id', delayRequestId);
      await notify(ext[nextStep], `已选「转紧急·不退交期」,请你(${roleCn(ext[nextStep])})确认下游能压缩到原交期。`);
      return { ok: true, done: false, urgent: true, nextRole: ext[nextStep] };
    }
    // 真正落地:push_delivery(退交期) 或 urgent 追加链已确认完 或 不影响交期
    await (svc.from('delay_requests') as any).update({ approvals, current_step: nextStep, updated_at: new Date().toISOString() }).eq('id', delayRequestId);
    if ((dr as any).reschedule_mode === 'urgent') {
      // 转紧急落地:不推整体交期(impacts_final_delivery=false)+ 订单标「交期紧急」
      await (svc.from('delay_requests') as any).update({ impacts_final_delivery: false }).eq('id', delayRequestId);
      try {
        const { data: ord } = await (svc.from('orders') as any).select('special_tags').eq('id', (dr as any).order_id).maybeSingle();
        const tags: string[] = Array.isArray((ord as any)?.special_tags) ? (ord as any).special_tags : [];
        if (!tags.includes('交期紧急')) await (svc.from('orders') as any).update({ special_tags: [...tags, '交期紧急'] }).eq('id', (dr as any).order_id);
      } catch { /* 标签失败不阻断 */ }
    } else if (mode === 'push_delivery') {
      await (svc.from('delay_requests') as any).update({ reschedule_mode: 'push_delivery' }).eq('id', delayRequestId);
    }
    const res = toLegacyResult(await approveDelayRequestCore(delayRequestId, note));   // 落地(core 对链已满放行)
    if ((res as any).error) return { error: (res as any).error };
    return { ok: true, done: true };
  }
  // 未到末位 → 推进 + 通知下一级
  await (svc.from('delay_requests') as any).update({ approvals, current_step: nextStep, updated_at: new Date().toISOString() }).eq('id', delayRequestId);
  await notify(chain[nextStep], `上一级已确认,请你(${roleCn(chain[nextStep])})接续确认此改期申请。`);
  return { ok: true, done: false, nextRole: chain[nextStep] };
}

async function approveDelayRequestCore(
  delayRequestId: string,
  decisionNote?: string,
): Promise<ActionResult<any>> {
  try {
  // 用户会话客户端 — 用于鉴权（auth.getUser + 角色读取）
  const userClient = await createClient();

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return failure('Unauthorized', 'AUTH_REQUIRED');

  // 权限：仅管理员可审批延期 — 这一步用 user session（profiles 走 RLS）
  const { data: profile } = await userClient
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  // 2026-06 起：CEO/admin 与业务部经理可审批延期（业务经理对客户交期负责）
  // 2026-07-05 P1：若该申请的多级审批链已走满(approveDeferralStep 逐级确认完成),
  // 则由链授权放行(链末位角色可能不在 CAN_APPROVE_DELAY,如 merchandiser),不再卡单人闸。
  if (!hasRoleInGroup(userRoles, 'CAN_APPROVE_DELAY')) {
    let chainComplete = false;
    try {
      const svc0 = createServiceRoleClient();
      const { data: cr } = await (svc0.from('delay_requests') as any)
        .select('approval_chain, current_step').eq('id', delayRequestId).maybeSingle();
      const ch = Array.isArray((cr as any)?.approval_chain) ? (cr as any).approval_chain : [];
      chainComplete = ch.length > 0 && Number((cr as any)?.current_step || 0) >= ch.length;
    } catch { /* 读不到就按无链处理 */ }
    if (!chainComplete) {
      return failure('延期审批权限不足，仅 CEO/管理员或业务部经理可批准。', 'PERMISSION_DENIED');
    }
  }

  // 鉴权通过后，所有数据操作用 service-role 客户端 — 绕过 delay_requests RLS 的
  // 多角色 / 老策略残留问题（2026-05-26 事故）。
  // 不可用时降级到 user session（开发环境可能没配 SUPABASE_SERVICE_ROLE_KEY）。
  let supabase: any;
  try {
    supabase = createServiceRoleClient();
  } catch (e: any) {
    console.warn('[approveDelayRequest] service-role 不可用，降级 user session:', e?.message);
    supabase = userClient;
  }

  // Get delay request
  const { data: delayRequest } = await supabase
    .from('delay_requests')
    .select('*')
    .eq('id', delayRequestId)
    .single();

  if (!delayRequest) return failure('Delay request not found', 'NOT_FOUND');

  const delayRequestData = delayRequest as any;

  if (!isApprovalPending(delayRequestData.status)) {
    return failure(
      `该延期申请已${delayRequestData.status === 'approved' ? '批准' : '处理'}，请刷新页面`,
      'CONFLICT',
    );
  }

  const isAdmin = userRoles.includes('admin');
  // P1 修:不能审批自己提交的延期(admin 例外)
  if (delayRequestData.requested_by === user.id && !isAdmin) {
    return failure('不能审批自己提交的延期申请', 'SELF_APPROVAL');
  }
  // P1 修:有未走满的多级审批链 → 不能单人直批,必须逐级确认(approveDeferralStep),与 bulkApprove 同口径;
  // 否则绕过采购/生产下游压缩逐级确认,留下 status=approved 但 current_step 未走满的矛盾态。
  const _dChain = Array.isArray(delayRequestData.approval_chain) ? delayRequestData.approval_chain : [];
  const _dStep = Number(delayRequestData.current_step) || 0;
  // 2026-07-11:CAN_APPROVE_DELAY 经理与 admin 同权,可对未走满的链单人直批(否则高洁 order_manager 卡在 CHAIN_INCOMPLETE)
  const _canApproveDelay = isAdmin || hasRoleInGroup(userRoles, 'CAN_APPROVE_DELAY');
  if (_dChain.length > 0 && _dStep < _dChain.length && !_canApproveDelay) {
    return failure('此改期有多级审批链未走满,请逐级确认(不能单人直批)', 'CHAIN_INCOMPLETE');
  }

  // Get milestone and order separately
  const { data: milestone } = await supabase
    .from('milestones')
    .select('*')
    .eq('id', delayRequestData.milestone_id)
    .single();

  if (!milestone) return failure('Milestone not found', 'NOT_FOUND');

  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', delayRequestData.order_id)
    .single();

  if (!order) return failure('Order not found', 'NOT_FOUND');

  const orderData = order as any;
  const milestoneData = milestone as any;

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

  if (updateError) return failure(updateError.message, 'DB_ERROR');

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

  // ── Runtime Hook 2: delay 批准 → 异步重算 confidence
  void (async () => {
    try {
      const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
      await recomputeDeliveryConfidence(orderData.id, {
        type: 'delay_approved',
        source: `delay_request:${delayRequestId}`,
        severity: 'info',
        payload: {
          delay_request_id: delayRequestId,
          milestone_id: delayRequestData.milestone_id,
          new_due_at: delayRequestData.proposed_new_due_at,
          new_anchor: delayRequestData.proposed_new_anchor_date,
          delay_days: delayRequestData.delay_days,
        },
        triggeredBy: user.id,
      });
    } catch (e: any) {
      console.error('[runtime-hook]', 'delay_approved hook crashed:', e?.message);
    }
  })();

  revalidatePath(`/orders/${orderData.id}`);
  revalidatePath('/orders');
  revalidatePath('/admin');
  revalidatePath('/dashboard');
  revalidatePath('/ceo');
  revalidatePath('/');

  return success(updatedRequest);
  } catch (err: any) {
    console.error('[approveDelayRequest] 异常:', err?.message);
    return failure(`审批异常：${err?.message || '未知错误'}`, 'UNKNOWN');
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

  const rejectChain: string[] = Array.isArray(delayRequestData.approval_chain) ? delayRequestData.approval_chain : [];
  const rejectStep = Number(delayRequestData.current_step) || 0;
  const rejectRole = rejectChain[rejectStep];
  const { canActOnDeferralStep } = await import('@/lib/domain/deferral-routing');
  if (!canActOnDeferralStep({ roles: rejectUserRoles, requiredRole: rejectRole, actorId: user.id, requesterId: delayRequestData.requested_by })) {
    const { roleCn } = await import('@/lib/domain/deferral-routing');
    return { error: `当前步骤需由「${roleCn(rejectRole || 'admin')}」驳回` };
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
  revalidatePath('/orders');
  revalidatePath('/admin');
  revalidatePath('/dashboard');
  revalidatePath('/ceo');
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

    // ── 日期链 invariant 校验（SSOT, 2026-05-18）──
    // 延期审批是历史上 ETA<ETD 等异常数据的主要入口。在写库前 merge 现有日期校验。
    try {
      const { validateDateChainWithUpdate, formatDateChainErrors } = await import('@/lib/domain/orderDates');
      const violations = validateDateChainWithUpdate(
        {
          order_date: orderData.order_date,
          factory_date: orderData.factory_date,
          etd: orderData.etd,
          warehouse_due_date: orderData.warehouse_due_date,
          eta: orderData.eta,
          cancel_date: orderData.cancel_date,
        },
        updates,
      );
      if (violations.length > 0) {
        console.error(
          `[approveDelayRequest] 日期链校验失败 — ${orderData.order_no}:`,
          formatDateChainErrors(violations),
        );
        // 不直接 throw — recalculateSchedule 是 fire-and-forget 副作用
        // 但记录到 milestone_logs 让 admin 看到
        await (supabase.from('milestone_logs') as any).insert({
          milestone_id: milestoneData.id,
          order_id: orderData.id,
          actor_user_id: null,
          action: 'delay_date_chain_violation',
          note: `延期审批通过但新日期破坏日期链：${formatDateChainErrors(violations)}。审批已记录但日期未写入订单 — 请人工核实。`,
        });
        return;
      }
    } catch (err: any) {
      console.error('[approveDelayRequest] 日期链校验异常:', err?.message);
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

    // 直接走 supabase，不经过 repo 层权限校验
    // （权限已在 approveDelayRequestCore 做了 admin 校验，此处是系统级联操作）
    if (allMilestones) {
      for (const m of allMilestones as any[]) {
        const due = dueMap[m.step_key as keyof typeof dueMap];
        if (due) {
          const { error: updErr } = await supabase
            .from('milestones')
            .update({ planned_at: due.toISOString(), due_at: due.toISOString() })
            .eq('id', m.id);
          if (updErr) {
            console.error(`[recalculateSchedule] anchor-branch: failed to update milestone ${m.id} (${m.step_key}):`, updErr.message);
          }
        }
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

    // 直接更新当前里程碑（系统级联操作，跳过 repo 层权限校验）
    const { error: curErr } = await supabase
      .from('milestones')
      .update({ planned_at: delayRequest.proposed_new_due_at, due_at: delayRequest.proposed_new_due_at })
      .eq('id', milestoneData.id);
    if (curErr) {
      console.error(`[recalculateSchedule] due_at-branch: failed to update current milestone ${milestoneData.id}:`, curErr.message);
    }

    // 保交期(hold):把下游未完成节点压进 [新节点日期, 锚点],绝不推过交期(与顺延的整体后移相反)。
    try {
      const anchorStr = orderData.incoterm === 'FOB'
        ? (orderData.etd || orderData.factory_date)
        : (orderData.warehouse_due_date || orderData.eta);
      const stepKey = milestoneData.step_key;
      if (anchorStr && stepKey) {
        const compressed = compressRemainingIntoWindow(stepKey, newDueAt, new Date(anchorStr + 'T00:00:00+08:00'));
        const { data: dsm } = await supabase
          .from('milestones').select('id, step_key, status')
          .eq('order_id', orderData.id).neq('id', milestoneData.id);
        for (const m of (dsm || []) as any[]) {
          const nd = (compressed as any)[m.step_key];
          if (!nd) continue;
          if (['done', '已完成'].includes(String(m.status || '').toLowerCase())) continue;   // 已完成不动
          const { error: dsErr } = await supabase.from('milestones')
            .update({ due_at: nd.toISOString(), planned_at: nd.toISOString() }).eq('id', m.id);
          if (dsErr) console.error(`[recalculateSchedule] 保交期压缩 ${m.step_key} 失败:`, dsErr.message);
        }
      }
    } catch (e: any) {
      console.error('[recalculateSchedule] 保交期压缩下游异常:', e?.message);
    }

    // 兜底:压缩只动下游,上游未完成节点可能仍停在过晚日期造成节点倒挂(如 中查>尾查)。
    // 按 TIMELINE 顺序做单调修复,只往前拉未完成节点,保证节点日期永不逆序。
    try {
      const { data: allM } = await supabase
        .from('milestones').select('id, step_key, status, due_at').eq('order_id', orderData.id);
      for (const r of monotonicRepairDueDates((allM || []) as any[])) {
        await supabase.from('milestones')
          .update({ due_at: r.due_at, planned_at: r.due_at }).eq('id', r.id);
      }
    } catch (e: any) {
      console.error('[recalculateSchedule] 单调修复异常:', e?.message);
    }

    await logMilestoneAction(
      supabase, milestoneData.id, orderData.id, 'recalc_schedule',
      `保交期:节点后移 ${deltaDays} 天,下游压入剩余窗口`,
      { new_due_at: delayRequest.proposed_new_due_at },
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

/**
 * 订单级二次延期申请
 *
 * 场景：出厂日已超期（甚至二次超期），需要正式走审批流程延期出厂日。
 * 做法：自动找订单中最后一个未完成的出运相关里程碑，对它创建 delay_request，
 *       并把 proposed_new_anchor_date 设为新出厂日，审批通过后全量重算排期。
 */
export async function createOrderLevelDelayRequest(
  orderId: string,
  reasonCategory: 'customer' | 'supplier' | 'internal' | 'force_majeure',
  reasonType: string,
  reasonDetail: string,
  newFactoryDate: string,
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  // 生命周期校验
  const { data: orderCheck } = await (supabase.from('orders') as any)
    .select('lifecycle_status, order_no, customer_name, incoterm, factory_date, etd, warehouse_due_date, created_by, owner_user_id')
    .eq('id', orderId).single();
  if (!orderCheck) return { error: '订单不存在' };
  const ls = orderCheck.lifecycle_status;
  if (ls === 'completed' || ls === '已完成') return { error: '该订单已完成，不能申请延期' };
  if (ls === 'cancelled' || ls === '已取消') return { error: '该订单已取消，不能申请延期' };
  if (ls === 'paused' || ls === '已暂停') return { error: '该订单已暂停，不能申请延期' };

  // 权限：订单创建者、负责人或管理员可申请
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = isAdminRole(userRoles);
  const isSales = userRoles.some(r => ['sales', 'sales_manager', 'merchandiser'].includes(r));
  const isOwner = orderCheck.created_by === user.id || orderCheck.owner_user_id === user.id;
  if (!isAdmin && !isSales && !isOwner) {
    return { error: '仅订单负责人或管理员可申请延期' };
  }

  // 新出厂日必须晚于今天
  if (newFactoryDate <= new Date().toISOString().slice(0, 10)) {
    return { error: '新出厂日期必须晚于今天' };
  }

  // 找最后一个未完成的出运相关里程碑（优先顺序：booking_done > factory_completion > inspection_release）
  const SHIPMENT_KEYS = ['booking_done', 'factory_completion', 'inspection_release', 'shipment_completed', 'shipment_done', 'domestic_delivery'];
  const { data: allMs } = await (supabase.from('milestones') as any)
    .select('id, step_key, status, due_at, owner_role, owner_user_id, name')
    .eq('order_id', orderId);

  let targetMilestone: any = null;
  for (const key of SHIPMENT_KEYS) {
    const ms = (allMs || []).find((m: any) => m.step_key === key && !isDoneStatus(m.status));
    if (ms) { targetMilestone = ms; break; }
  }
  // fallback：任意最后一个未完成的里程碑
  if (!targetMilestone && allMs && allMs.length > 0) {
    const undone = (allMs as any[]).filter(m => !isDoneStatus(m.status));
    targetMilestone = undone[undone.length - 1] || allMs[allMs.length - 1];
  }
  if (!targetMilestone) return { error: '未找到可关联的里程碑，无法提交延期申请' };

  // 防重复：同一里程碑不允许有多条 pending 延期请求
  const { data: existingPending } = await (supabase.from('delay_requests') as any)
    .select('id').eq('milestone_id', targetMilestone.id).eq('status', 'pending').limit(1);
  if (existingPending && existingPending.length > 0) {
    return { error: '该节点已有待审批的延期申请，请等待审批后再提交' };
  }

  const { DELAY_CATEGORIES } = await import('@/lib/domain/delay-rules');
  const categoryInfo = DELAY_CATEGORIES[reasonCategory];
  const currentAnchor = orderCheck.incoterm === 'FOB' ? (orderCheck.factory_date || orderCheck.etd) : orderCheck.warehouse_due_date;
  const delayDays = currentAnchor
    ? Math.ceil((new Date(newFactoryDate).getTime() - new Date(currentAnchor).getTime()) / 86400000)
    : 0;

  const { data: delayRequest, error: insertErr } = await (supabase.from('delay_requests') as any)
    .insert({
      order_id: orderId,
      milestone_id: targetMilestone.id,
      requested_by: user.id,
      reason_type: reasonType,
      reason_category: reasonCategory,
      reason_detail: reasonDetail,
      proposed_new_anchor_date: newFactoryDate,
      proposed_new_due_at: null,
      requires_customer_approval: categoryInfo.requiresCustomerApproval,
      delay_days: delayDays,
      impacts_final_delivery: true,
      status: 'pending',
    })
    .select().single();

  if (insertErr) return { error: insertErr.message };

  await logMilestoneAction(supabase, targetMilestone.id, orderId, 'request_delay',
    `[二次延期] ${reasonDetail}`, { delay_request_id: (delayRequest as any).id, new_factory_date: newFactoryDate });

  // 通知管理员
  const requesterName = (profile as any)?.name || user.email?.split('@')[0] || '员工';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com';
  const orderLink = `${appUrl}/orders/${orderId}?tab=delays`;
  const subject = `[二次延期申请] ${requesterName} — ${orderCheck.order_no} · 新出厂日 ${newFactoryDate}`;
  const body = `
    <div style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);padding:24px;border-radius:12px 12px 0 0;">
        <h2 style="color:white;margin:0;font-size:22px;">🔄 二次延期申请待审批</h2>
        <p style="color:#fecaca;margin:8px 0 0;font-size:14px;">出厂日已超期，申请人申请再次延期</p>
      </div>
      <div style="background:white;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          <tr><td style="padding:8px 0;color:#6b7280;width:100px;">订单号</td>
              <td style="padding:8px 0;font-weight:600;"><a href="${orderLink}" style="color:#4f46e5;">${orderCheck.order_no}</a></td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">客户</td>
              <td style="padding:8px 0;font-weight:600;">${orderCheck.customer_name || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">原出厂日</td>
              <td style="padding:8px 0;">${currentAnchor || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">申请新出厂日</td>
              <td style="padding:8px 0;font-weight:600;color:#dc2626;">${newFactoryDate}（延期 ${delayDays} 天）</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">延期原因</td>
              <td style="padding:8px 0;">${reasonType}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top;">详细说明</td>
              <td style="padding:8px 0;line-height:1.6;">${escapeHtml(reasonDetail)}</td></tr>
        </table>
        <a href="${orderLink}" style="display:inline-block;background:#dc2626;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">去审批处理</a>
      </div>
    </div>
  `;
  const { data: admins } = await (supabase.from('profiles') as any).select('user_id').or('role.eq.admin,roles.cs.{admin}');
  const adminUserIds: string[] = [];
  for (const admin of admins || []) {
    await (supabase.from('notifications') as any).insert({
      user_id: admin.user_id,
      type: 'delay_request',
      title: `${requesterName} 申请二次延期：${orderCheck.order_no}`,
      message: `新出厂日：${newFactoryDate}（延期 ${delayDays} 天）\n原因：${reasonDetail.slice(0, 100)}`,
      related_order_id: orderId,
      related_milestone_id: targetMilestone.id,
      status: 'unread',
    });
    adminUserIds.push(admin.user_id);
  }
  // 2026-07-11:整单延期原来只通知 admin,业务经理(order_manager/sales_manager)收不到 → 补通知管理审批人
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(supabase, ['admin', 'order_manager', 'sales_manager'], {
      type: 'delay_request',
      title: `🕒 整单延期待审批:${orderCheck.order_no}`,
      message: `${requesterName} 申请整单延期,新出厂日 ${newFactoryDate}(延期 ${delayDays} 天);原因:${reasonDetail.slice(0, 100)}。请到该订单「延期」处审批。`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[createOrderLevelDelayRequest] 经理待审批通知失败(不阻断):', e?.message); }
  const ccEmails = MANAGER_CC_EMAILS;
  await sendEmailNotification(ccEmails, subject, body).catch(() => {});

  if (adminUserIds.length > 0) {
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      await pushToUsers(supabase, adminUserIds,
        `🔄 ${requesterName} 申请二次延期`,
        `订单：${orderCheck.order_no}（${orderCheck.customer_name || '—'}）\n新出厂日：${newFactoryDate}\n原因：${reasonType}\n${reasonDetail.slice(0, 80)}\n\n${orderLink}`
      );
    } catch (e: any) { console.warn(`[delays] 延期申请次要操作 1133:`, e?.message); }
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  revalidatePath('/admin');
  revalidatePath('/ceo');

  return { data: delayRequest, delayRequestId: (delayRequest as any)?.id };
}

export async function getDelayRequestsByOrder(orderId: string) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Unauthorized' };
  }

  // 2026-07-11:订单可见性交给 orders RLS 把关(now 含 order_manager);延期+里程碑用 service-role 读全量。
  //   原来 user-session + milestones!inner:业务执行经理(高洁)能看订单,但 milestones RLS(严:owner/canSeeAll)
  //   让 inner join 空 → 延期面板「订单暂无延期记录」、没有「去审批」按钮。与 getMilestonesByOrder 同款修法。
  const { data: ord } = await (supabase.from('orders') as any).select('id').eq('id', orderId).maybeSingle();
  if (!ord) return { error: '无权查看该订单' };   // orders RLS 挡住 = 没权限
  const svc = createServiceRoleClient();

  // 用 milestone 别名（单数）便于 UI 读取
  const { data: requests, error } = await (svc
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

// ──────────────────────────────────────────────────────────────────────
// 批量批准所有待处理延期申请
// 一次性清理积压，每条都走完整 approveDelayRequestCore（含日期链 / 日志 /
// 通知 / runtime 重算）。失败的继续往下走，最后汇总。
// ──────────────────────────────────────────────────────────────────────
export async function bulkApproveAllPendingDelays(
  decisionNote?: string,
): Promise<{
  ok: boolean;
  approved: number;
  failed: number;
  skipped: number;
  total: number;
  errors?: Array<{ id: string; reason: string }>;
  message: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, approved: 0, failed: 0, skipped: 0, total: 0, message: '未登录' };
  }

  // 权限：与单个 approveDelayRequestCore 一致 — 仅管理员
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] =
    (profile as any)?.roles?.length > 0
      ? (profile as any).roles
      : [(profile as any)?.role].filter(Boolean);
  if (!hasRoleInGroup(userRoles, 'CAN_APPROVE_DELAY')) {
    return { ok: false, approved: 0, failed: 0, skipped: 0, total: 0, message: '仅管理员或业务部经理可批准延期申请' };
  }

  // 拉所有 pending 延期申请 — 用 service-role 绕过 RLS（admin 已校验过）
  let queryClient: any = supabase;
  try {
    queryClient = createServiceRoleClient();
  } catch (e: any) {
    console.warn('[bulkApprove] service-role 不可用，降级 user session:', e?.message);
  }
  // 拉 pending + 审批链状态(P0 复审修:批量不能绕过多级链)
  let pendingRows: any[] | null = null;
  let queryError: any = null;
  ({ data: pendingRows, error: queryError } = await (queryClient.from('delay_requests') as any)
    .select('id, approval_chain, current_step')
    .eq('status', 'pending').order('created_at', { ascending: true }).limit(200));
  if (queryError && /approval_chain|current_step|does not exist/i.test(queryError.message || '')) {
    // 迁移未执行时降级:只拉 id,全部按无链处理(旧行为)
    ({ data: pendingRows, error: queryError } = await (queryClient.from('delay_requests') as any)
      .select('id').eq('status', 'pending').order('created_at', { ascending: true }).limit(200));
  }
  if (queryError) {
    return { ok: false, approved: 0, failed: 0, skipped: 0, total: 0, message: `查询失败: ${queryError.message}` };
  }

  const rows = (pendingRows || []) as any[];
  if (rows.length === 0) {
    return { ok: true, approved: 0, failed: 0, skipped: 0, total: 0, message: '没有待批准的延期申请' };
  }

  const note = decisionNote || '批量批准（系统清理积压）';
  const errors: Array<{ id: string; reason: string }> = [];
  let approved = 0;
  let skipped = 0;

  // 串行处理（每条都有 DB 操作 + 副作用，并行容易出竞态）
  for (const row of rows) {
    // P0 复审修:有未走满的多级审批链 → 跳过批量,必须逐级确认(否则会绕过链、留下 status=approved 但 current_step=0 的矛盾态)
    const chain = row.approval_chain;
    const step = Number(row.current_step) || 0;
    if (Array.isArray(chain) && chain.length > 0 && step < chain.length) {
      skipped++; // 不计入 errors(非失败),仍留在 pending 列表待逐级确认
      continue;
    }
    try {
      const result = await approveDelayRequestCore(row.id, note);
      if (result.ok) {
        approved++;
      } else {
        errors.push({ id: row.id, reason: result.error || '未知错误' });
      }
    } catch (e: any) {
      errors.push({ id: row.id, reason: e?.message || String(e) });
    }
  }

  revalidatePath('/admin/pending-approvals');
  revalidatePath('/orders');
  revalidatePath('/admin');
  revalidatePath('/dashboard');
  revalidatePath('/ceo');
  revalidatePath('/');

  const failed = errors.length;
  return {
    ok: true,
    approved,
    failed,
    skipped,
    total: rows.length,
    errors: failed > 0 ? errors.slice(0, 10) : undefined, // 只返回前 10 条避免 payload 太大
    message: `共 ${rows.length} 条，成功 ${approved} 条${failed > 0 ? `，失败 ${failed} 条` : ''}${skipped > 0 ? `，跳过 ${skipped} 条(有未完成的多级审批链,需逐级确认)` : ''}${rows.length === 200 ? '（达到单次上限 200，请再次点击处理剩余）' : ''}`,
  };
}
