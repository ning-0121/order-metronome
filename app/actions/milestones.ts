'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { isOverdue, addWorkingDays, ensureBusinessDay } from '@/lib/utils/date';
import {
  updateMilestone,
  createMilestone,
  transitionMilestoneStatus,
} from '@/lib/repositories/milestonesRepo';
import { normalizeMilestoneStatus, isDoneStatus } from '@/lib/domain/types';
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

/** 检查订单是否允许修改关卡（已取消/已完成的订单禁止操作） */
async function checkOrderModifiable(supabase: any, orderId: string): Promise<string | null> {
  const { data: order } = await (supabase.from('orders') as any)
    .select('lifecycle_status')
    .eq('id', orderId)
    .single();
  if (!order) return '订单不存在';
  const status = order.lifecycle_status;
  if (status === 'completed' || status === '已完成') return '该订单已完成，不能修改关卡';
  if (status === 'cancelled' || status === '已取消') return '该订单已取消，不能修改关卡';
  return null; // 可修改
}

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

export async function markMilestoneDone(
  milestoneId: string,
  checklistData?: Array<{ key: string; value: any; pending_date?: string }> | null,
) {
  try {
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

  // 生命周期校验：已完成/已取消的订单禁止操作
  const lifecycleError = await checkOrderModifiable(supabase, milestone.order_id);
  if (lifecycleError) return { error: lifecycleError };

  // Check role: must be assigned user or matching owner_role
  // 管理员不能替代执行关卡（管理员负责监督、指派、审批，不替代一线操作）
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  // 管理员禁止标记完成（管理员负责监督，不替代一线操作；多角色管理员同样受限）
  if (userRoles.includes('admin')) {
    return { error: '管理员不能标记关卡完成，请由对应角色的负责人操作' };
  }

  const isAssignedUser = milestone.owner_user_id === user.id;
  // 角色合并：production/qc/quality 都归入 merchandiser
  const merchGroup = ['merchandiser', 'production', 'qc', 'quality'];
  const roleMatches = milestone.owner_role && userRoles.some(
    (r: string) => {
      const nr = r.toLowerCase();
      const or = (milestone.owner_role as string).toLowerCase();
      if (nr === or) return true;
      if ((or === 'sales' && nr === 'merchandiser') || (or === 'merchandiser' && nr === 'sales')) return true;
      if (merchGroup.includes(or) && merchGroup.includes(nr)) return true;
      return false;
    }
  );
  if (!isAssignedUser && !roleMatches) {
    return { error: '无权操作：只有对应角色的负责人可以标记完成' };
  }

  // 自动认领：如果该关卡尚未分配具体负责人，且操作者角色匹配，自动认领
  if (!milestone.owner_user_id && roleMatches) {
    await (supabase.from('milestones') as any)
      .update({ owner_user_id: user.id })
      .eq('id', milestoneId);
  }

  // Check checklist completion (if milestone has a checklist)
  const { hasChecklistForStep, validateChecklistComplete } = await import('@/lib/domain/checklist');
  if (hasChecklistForStep(milestone.step_key)) {
    // 如果客户端传入了清单数据，先保存到 DB（一步完成，无需用户手动点保存）
    if (checklistData && checklistData.length > 0) {
      const now = new Date().toISOString();
      // 获取已有数据并合并
      const { data: existingMs } = await (supabase.from('milestones') as any)
        .select('checklist_data').eq('id', milestoneId).single();
      const existing: Array<{ key: string; value: any; pending_date?: string; updated_at: string; updated_by: string }> = existingMs?.checklist_data || [];
      const mergeMap = new Map(existing.map((r: any) => [r.key, r]));
      for (const item of checklistData) {
        mergeMap.set(item.key, {
          key: item.key,
          value: item.value,
          pending_date: item.pending_date || undefined,
          updated_at: now,
          updated_by: user.id,
        });
      }
      const merged = Array.from(mergeMap.values());
      // 保存（先尝试 RPC，失败则直接更新）
      const { error: rpcErr } = await (supabase.rpc as any)('admin_update_milestone', {
        _milestone_id: milestoneId,
        _updates: { checklist_data: JSON.stringify(merged) },
      });
      if (rpcErr) {
        await (supabase.from('milestones') as any)
          .update({ checklist_data: merged })
          .eq('id', milestoneId);
      }
    }

    // 再从 DB 读取验证
    const { data: msWithChecklist } = await (supabase.from('milestones') as any)
      .select('checklist_data').eq('id', milestoneId).single();
    const checkResult = validateChecklistComplete(milestone.step_key, msWithChecklist?.checklist_data || null);
    if (!checkResult.valid) {
      return { error: `检查清单未完成，缺少：${checkResult.missing.join('、')}` };
    }
  }

  // 质量门禁：出运相关节点必须在尾查通过后才能操作
  const SHIPMENT_GATES = ['inspection_release', 'booking_done', 'customs_export', 'finance_shipment_approval', 'shipment_execute'];
  if (SHIPMENT_GATES.includes(milestone.step_key)) {
    const { data: qcMilestone } = await (supabase.from('milestones') as any)
      .select('status, checklist_data')
      .eq('order_id', (milestone as any).order_id)
      .eq('step_key', 'final_qc_check')
      .single();
    if (qcMilestone) {
      const qcStatus = normalizeMilestoneStatus(qcMilestone.status);
      if (qcStatus !== '已完成') {
        return { error: '尾期验货尚未完成，不能操作出运相关节点' };
      }
      // 检查尾查结果是否为 FAIL
      // checklist_data 存储为数组 [{key, value, ...}]，可能是 JSON 字符串
      let qcItems: any[] = [];
      const rawQc = qcMilestone.checklist_data;
      if (Array.isArray(rawQc)) {
        qcItems = rawQc;
      } else if (typeof rawQc === 'string') {
        try { const p = JSON.parse(rawQc); if (Array.isArray(p)) qcItems = p; } catch {}
      }
      const qcResultItem = qcItems.find((item: any) => item.key === 'final_qc_result');
      if (qcResultItem) {
        const val = String(qcResultItem.value || '');
        if (val.includes('FAIL') || val.includes('不通过') || val === '不合格') {
          return { error: '尾期验货结果为不合格，不能出运。请先处理质量问题后重新验货' };
        }
      }
    }
  }

  // 延期门禁：超期里程碑必须先提交延期申请才能标记完成
  const milestoneData_precheck = milestone as any;
  if (milestoneData_precheck.due_at) {
    const dueDate = new Date(milestoneData_precheck.due_at);
    const now = new Date();
    if (now > dueDate) {
      // 检查是否已提交延期申请
      const { data: delayReqs } = await (supabase.from('delay_requests') as any)
        .select('id, status')
        .eq('milestone_id', milestoneId)
        .in('status', ['pending', 'approved']);
      if (!delayReqs || delayReqs.length === 0) {
        return {
          error: '此节点已超期，请先在「延期申请」中提交延期申请后再标记完成。未经审批的超期会影响订单整体评分。'
        };
      }
    }
  }

  // Check if evidence is required and exists（双表检查）
  if (milestone.evidence_required) {
    // 先查 attachments 表
    const { data: att1 } = await (supabase.from('attachments') as any)
      .select('id')
      .eq('milestone_id', milestoneId)
      .limit(1);
    // 再查 order_attachments 表
    const { data: att2 } = await (supabase.from('order_attachments') as any)
      .select('id')
      .eq('milestone_id', milestoneId)
      .limit(1);

    const hasEvidence = (att1 && att1.length > 0) || (att2 && att2.length > 0);
    if (!hasEvidence) {
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
        const anchorDate = new Date(anchor + 'T00:00:00+08:00');
        // 安全线 = 交期前21天（需要留够生产时间）
        const safetyDate = new Date(anchorDate);
        safetyDate.setDate(safetyDate.getDate() - 21);
        const delayDays = Math.ceil((actualDelivery.getTime() - safetyDate.getTime()) / (1000 * 60 * 60 * 24));
        if (delayDays > 0) {
          // 交期风险！创建通知给管理员（从数据库查询，不硬编码）
          const { data: adminProfiles } = await (supabase
            .from('profiles') as any)
            .select('user_id')
            .or('role.eq.admin,roles.cs.{admin}');
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

  // 阶段1全部完成 → 自动激活订单（草稿→已生效）
  const stage1Keys = ['po_confirmed', 'finance_approval', 'order_kickoff_meeting', 'production_order_upload'];
  if (stage1Keys.includes(milestoneData.step_key)) {
    const { data: stage1Milestones } = await (supabase.from('milestones') as any)
      .select('step_key, status')
      .eq('order_id', milestoneData.order_id)
      .in('step_key', stage1Keys);
    const allStage1Done = stage1Milestones && stage1Milestones.length === 4 &&
      stage1Milestones.every((m: any) => isDoneStatus(m.status));
    if (allStage1Done) {
      const { data: orderCheck } = await (supabase.from('orders') as any)
        .select('lifecycle_status').eq('id', milestoneData.order_id).single();
      if (orderCheck?.lifecycle_status === 'draft') {
        const { activateOrder } = await import('@/lib/repositories/ordersRepo');
        await activateOrder(milestoneData.order_id);
      }
    }
  }

  revalidatePath(`/orders/${milestoneData.order_id}`);
  revalidatePath('/dashboard');
  revalidatePath('/orders');

  return { data: updatedMilestone };
  } catch (err: any) {
    // 捕获所有未处理异常，返回可读错误而非 Next.js 通用错误
    console.error('[markMilestoneDone] 未捕获异常:', err?.message, err?.stack);
    return { error: `服务端异常：${err?.message || '未知错误'}` };
  }
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

  // 生命周期校验
  const lifecycleErr = await checkOrderModifiable(supabase, milestone.order_id);
  if (lifecycleErr) return { error: lifecycleErr };

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
  const { data: pendingMilestones } = await (supabase
    .from('milestones') as any)
    .select('*')
    .eq('order_id', orderId)
    .eq('status', 'pending')
    .order('sequence_number', { ascending: true });

  if (pendingMilestones && pendingMilestones.length > 0) {
    const next = pendingMilestones[0];

    // 推进为进行中
    await transitionMilestoneStatus(next.id, '进行中', '自动推进：上一节点已完成');

    // 如果该节点的 due_at 已过期，自动延后到今天+2个工作日
    // 避免"一推进就逾期"的问题
    if (next.due_at) {
      const now = new Date();
      const dueAt = new Date(next.due_at);
      if (dueAt < now) {
        const { ensureBusinessDay, addWorkingDays } = await import('@/lib/utils/date');
        const newDue = ensureBusinessDay(addWorkingDays(now, 2));
        const { error: rpcErr2 } = await (supabase.rpc as any)('admin_update_milestone', {
          _milestone_id: next.id,
          _updates: { due_at: newDue.toISOString(), planned_at: newDue.toISOString() },
        });
        if (rpcErr2) {
          await (supabase.from('milestones') as any)
            .update({ due_at: newDue.toISOString(), planned_at: newDue.toISOString() })
            .eq('id', next.id);
        }
      }
    }
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

  // 生命周期校验
  if (milestone) {
    const lcErr = await checkOrderModifiable(supabase, (milestone as any).order_id);
    if (lcErr) return { error: lcErr };
  }
  
  if (milestone) {
    revalidatePath(`/orders/${(milestone as any).order_id}`);
    revalidatePath('/dashboard');
  }
  
  return { data: result.data };
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

  // 生命周期校验
  const { data: msForCheck } = await (supabase.from('milestones') as any)
    .select('order_id').eq('id', milestoneId).single();
  if (msForCheck) {
    const lcErr = await checkOrderModifiable(supabase, msForCheck.order_id);
    if (lcErr) return { error: lcErr };
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
    .select('id, order_id, step_key, name, due_at, owner_role, owner_user_id')
    .eq('id', milestoneId)
    .limit(1);
  const milestone = milestoneArr?.[0];
  if (getErr || !milestone) return { error: '找不到该节点' };

  // 权限：仅关卡对应角色或指定负责人可填写实际日期
  const { data: dateProfile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const dateUserRoles: string[] = (dateProfile as any)?.roles?.length > 0 ? (dateProfile as any).roles : [(dateProfile as any)?.role].filter(Boolean);
  const isDateAssigned = milestone.owner_user_id === user.id;
  const dateRoleMatches = milestone.owner_role && dateUserRoles.some(
    (r: string) => r.toLowerCase() === milestone.owner_role.toLowerCase()
      || (milestone.owner_role === 'sales' && r === 'merchandiser')
      || (milestone.owner_role === 'merchandiser' && r === 'sales')
  );
  if (!isDateAssigned && !dateRoleMatches) {
    return { error: '仅对应角色的负责人可填写实际日期' };
  }

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
    const actualDate = new Date(actualAt + 'T00:00:00+08:00');
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
  
  // Update owner_user_id（用RPC绕过RLS）
  await (supabase.rpc as any)('admin_update_milestone', {
    _milestone_id: milestoneId,
    _updates: { owner_user_id: ownerUserId },
  }).catch(() => {});

  // fallback直接更新
  const { error: updateError } = await (supabase
    .from('milestones') as any)
    .update({ owner_user_id: ownerUserId })
    .eq('id', milestoneId);

  if (updateError) {
    return { error: updateError.message };
  }

  const updated = { id: milestoneId, owner_user_id: ownerUserId };
  
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

/**
 * 批量指定跟单负责人：将订单中所有 owner_role='merchandiser' 的关卡分配给指定用户。
 * 仅管理员或订单创建者可操作。
 */
export async function assignMerchandiser(
  orderId: string,
  merchandiserUserId: string
): Promise<{ data?: { updated: number }; error?: string }> {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 权限：管理员 或 订单创建者
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = userRoles.includes('admin');

  if (!isAdmin) {
    const { data: order } = await (supabase.from('orders') as any)
      .select('owner_user_id')
      .eq('id', orderId)
      .single();
    if (!order || order.owner_user_id !== user.id) {
      return { error: '只有管理员或订单负责人可以指定跟单' };
    }
  }

  // 验证目标用户确实是跟单角色
  const { data: targetProfile } = await (supabase.from('profiles') as any)
    .select('name, role, roles')
    .eq('user_id', merchandiserUserId)
    .single();
  if (!targetProfile) return { error: '目标用户不存在' };

  const targetRoles: string[] = targetProfile.roles?.length > 0 ? targetProfile.roles : [targetProfile.role].filter(Boolean);
  if (!targetRoles.includes('merchandiser') && !targetRoles.includes('admin')) {
    return { error: '目标用户不是跟单角色' };
  }

  // 批量更新
  const { data: updated, error: updateErr } = await (supabase.from('milestones') as any)
    .update({ owner_user_id: merchandiserUserId })
    .eq('order_id', orderId)
    .eq('owner_role', 'merchandiser')
    .select('id');

  if (updateErr) return { error: updateErr.message };

  // 日志
  const updatedCount = (updated || []).length;
  for (const m of updated || []) {
    await logMilestoneAction(
      supabase, m.id, orderId, 'update',
      `跟单负责人指定为：${targetProfile.name || merchandiserUserId}`
    );
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/dashboard');

  return { data: { updated: updatedCount } };
}

// ══════════════════════════════════════════════
// 检查清单操作
// ══════════════════════════════════════════════

/**
 * 保存节点检查清单数据
 * 如有影响排期的 pending_date，自动触发下游重算
 */
export async function saveChecklistData(
  milestoneId: string,
  responses: Array<{ key: string; value: boolean | string | null; pending_date?: string }>
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 获取当前 milestone
  const { data: milestone } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, checklist_data, due_at')
    .eq('id', milestoneId)
    .single();
  if (!milestone) return { error: '节点不存在' };

  // 生命周期校验
  const lcErr = await checkOrderModifiable(supabase, milestone.order_id);
  if (lcErr) return { error: lcErr };

  // 角色校验：只能编辑自己角色对应的检查项
  const { getChecklistForStep } = await import('@/lib/domain/checklist');
  const checklistConfig = getChecklistForStep(milestone.step_key);
  if (checklistConfig) {
    const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
    const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
    for (const r of responses) {
      const itemDef = checklistConfig.items.find((i: any) => i.key === r.key);
      if (itemDef && !userRoles.some((ur: string) => ur.toLowerCase() === itemDef.role.toLowerCase())) {
        return { error: `无权编辑「${itemDef.label}」（需要${itemDef.role}角色）` };
      }
    }
  }

  // 业务规则校验：开裁单耗 — 实际单耗必须 ≤ 报价单耗
  if (milestone.step_key === 'production_kickoff') {
    const quoteVal = responses.find(r => r.key === 'quote_consumption')?.value;
    const actualVal = responses.find(r => r.key === 'actual_consumption')?.value;
    if (quoteVal && actualVal && Number(actualVal) > Number(quoteVal)) {
      return { error: `实际单耗（${actualVal}）超过报价单耗（${quoteVal}），不允许开裁。请与工厂沟通优化排料方案。` };
    }
  }

  // 合并响应（保留其他用户填的项，更新当前用户填的项）
  const existing: Array<{ key: string; value: any; pending_date?: string; updated_at: string; updated_by: string }> = milestone.checklist_data || [];
  const existingMap = new Map(existing.map(r => [r.key, r]));
  const now = new Date().toISOString();

  for (const r of responses) {
    existingMap.set(r.key, {
      key: r.key,
      value: r.value,
      pending_date: r.pending_date || undefined,
      updated_at: now,
      updated_by: user.id,
    });
  }

  const merged = Array.from(existingMap.values());

  // 保存到数据库（用 RPC 绕过 RLS）
  const { error: rpcSaveErr } = await (supabase.rpc as any)('admin_update_milestone', {
    _milestone_id: milestoneId,
    _updates: { checklist_data: JSON.stringify(merged) },
  });
  if (rpcSaveErr) {
    // RPC 不可用时 fallback 到直接更新
    await (supabase.from('milestones') as any)
      .update({ checklist_data: merged })
      .eq('id', milestoneId);
  }

  // 检查是否有影响排期的项
  const { getScheduleAffectingItems } = await import('@/lib/domain/checklist');
  const scheduleItems = getScheduleAffectingItems(milestone.step_key, merged);

  if (scheduleItems.length > 0) {
    // 找到最晚的预计确认日期
    const latestDate = scheduleItems.reduce((latest, item) => {
      const d = new Date(item.pending_date);
      return d > latest ? d : latest;
    }, new Date(0));

    // 如果预计日期晚于当前节点 due_at，需要调整下游排期
    const currentDue = milestone.due_at ? new Date(milestone.due_at) : new Date();
    if (latestDate > currentDue) {
      const { recalcRemainingDueDates } = await import('@/lib/schedule');
      const { ensureBusinessDay } = await import('@/lib/utils/date');

      // 获取订单的锚点
      const { data: order } = await (supabase.from('orders') as any)
        .select('etd, warehouse_due_date, incoterm')
        .eq('id', milestone.order_id)
        .single();

      if (order) {
        const anchorStr = order.incoterm === 'FOB' ? order.etd : order.warehouse_due_date;
        if (anchorStr) {
          const rawAnchor = new Date(anchorStr + 'T00:00:00+08:00');
          const { DDP_TRANSIT_DAYS } = await import('@/lib/schedule');
          const anchor = order.incoterm === 'DDP' ? new Date(rawAnchor.getTime() - DDP_TRANSIT_DAYS * 86400000) : rawAnchor;

          const newDates = recalcRemainingDueDates(milestone.step_key, anchor, latestDate);

          // 更新下游未完成节点
          const { data: downstreamMs } = await (supabase.from('milestones') as any)
            .select('id, step_key, status, sequence_number')
            .eq('order_id', milestone.order_id)
            .in('status', ['pending', 'in_progress'])
            .order('sequence_number', { ascending: true });

          const currentMs = (downstreamMs || []).find((m: any) => m.id === milestoneId);
          const currentSeq = currentMs?.sequence_number || 0;

          for (const ms of (downstreamMs || [])) {
            if (ms.sequence_number <= currentSeq) continue;
            const newDate = newDates[ms.step_key];
            if (newDate) {
              const dateStr = ensureBusinessDay(newDate).toISOString();
              await (supabase.rpc as any)('admin_update_milestone', {
                _milestone_id: ms.id,
                _updates: { due_at: dateStr, planned_at: dateStr },
              }).catch((err: any) => {
                console.warn(`[checklist] Failed to update downstream milestone ${ms.step_key}:`, err?.message || err);
              });
            }
          }
        }
      }
    }
  }

  // 日志
  await logMilestoneAction(supabase, milestoneId, milestone.order_id, 'update', '更新检查清单');

  revalidatePath(`/orders/${milestone.order_id}`);
  return {};
}
