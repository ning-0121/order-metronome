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

/**
 * 检查订单是否允许修改关卡
 * - 普通角色：已完成 / 已取消订单禁止操作
 * - 管理员：可强制操作（用于历史数据修复 / 状态回滚）
 */
async function checkOrderModifiable(
  supabase: any,
  orderId: string,
  isAdmin: boolean = false,
): Promise<string | null> {
  if (isAdmin) return null; // 管理员后门：任意状态都允许操作
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
    .select('order_id, evidence_required, owner_role, owner_user_id, step_key, status, actual_at, due_at, name')
    .eq('id', milestoneId)
    .single();
  
  if (getError || !milestone) {
    return { error: getError?.message || '找不到该执行节点' };
  }

  // 角色解析
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = userRoles.includes('admin');

  // 生命周期校验：已完成/已取消的订单禁止操作（管理员可强制）
  const lifecycleError = await checkOrderModifiable(supabase, milestone.order_id, isAdmin);
  if (lifecycleError) return { error: lifecycleError };

  // 管理员可以代标完成（用于一线人员离职/休假的应急场景），但日志会标注「管理员代操作」
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
  if (!isAssignedUser && !roleMatches && !isAdmin) {
    return { error: '无权操作：只有对应角色的负责人或管理员可以标记完成' };
  }

  // 顺序约束：某些节点必须等前置节点完成（管理员可绕过）
  // 修复 2026-04-08：之前业务员可以"先寄出后准备"，逻辑荒谬
  const SEQUENTIAL_REQUIREMENTS: Record<string, string[]> = {
    pre_production_sample_sent: ['pre_production_sample_ready'],
    pre_production_sample_approved: ['pre_production_sample_ready', 'pre_production_sample_sent'],
    mid_qc_sales_check: ['mid_qc_check'],
    final_qc_sales_check: ['final_qc_check'],
  };
  const prerequisites = SEQUENTIAL_REQUIREMENTS[milestone.step_key];
  if (prerequisites && !isAdmin) {
    const { data: prereqRows } = await (supabase.from('milestones') as any)
      .select('step_key, status, name')
      .eq('order_id', milestone.order_id)
      .in('step_key', prerequisites);
    const notDone = (prereqRows || []).filter((m: any) => {
      const s = String(m.status || '').toLowerCase();
      return s !== 'done' && s !== '已完成';
    });
    if (notDone.length > 0) {
      const names = notDone.map((m: any) => m.name || m.step_key).join('、');
      return { error: `必须先完成前置节点：${names}` };
    }
  }

  // 自动认领：如果该关卡尚未分配具体负责人，且操作者角色匹配，自动认领
  if (!milestone.owner_user_id && roleMatches) {
    await (supabase.from('milestones') as any)
      .update({ owner_user_id: user.id })
      .eq('id', milestoneId);
  }

  // ── 经营控制门禁：确认链 + 付款状态阻塞（管理员可绕过）──
  if (!isAdmin) {
    try {
      const { getBlockedReasons } = await import('@/lib/engine/blockRules');
      const [confRes, finRes, orderRes] = await Promise.all([
        (supabase.from('order_confirmations') as any)
          .select('module, status')
          .eq('order_id', milestone.order_id),
        (supabase.from('order_financials') as any)
          .select('deposit_status, balance_status, payment_hold, allow_production, allow_shipment')
          .eq('order_id', milestone.order_id)
          .maybeSingle(),
        (supabase.from('orders') as any)
          .select('incoterm')
          .eq('id', milestone.order_id)
          .single(),
      ]);

      const blockResult = getBlockedReasons(
        milestone.step_key,
        confRes.data || [],
        finRes.data || null,
        orderRes.data?.incoterm,
      );

      if (blockResult.blocked) {
        return { error: `无法完成此节点：${blockResult.hardBlocks[0]}` };
      }
    } catch {} // 阻塞检查失败不阻断（降级）
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
      let existing: Array<{ key: string; value: any; pending_date?: string; updated_at: string; updated_by: string }> = [];
      const rawData = existingMs?.checklist_data;
      if (Array.isArray(rawData)) existing = rawData;
      else if (typeof rawData === 'string') { try { const p = JSON.parse(rawData); if (Array.isArray(p)) existing = p; } catch {} }
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

    // 双签校验：order_kickoff_meeting 必须 sales 和 admin 是不同的人
    if (milestone.step_key === 'order_kickoff_meeting') {
      const checklistArr = Array.isArray(msWithChecklist?.checklist_data)
        ? msWithChecklist!.checklist_data
        : [];
      const salesEntry = checklistArr.find((r: any) => r.key === 'sales_signed');
      const ceoEntry = checklistArr.find((r: any) => r.key === 'ceo_signed');
      if (!salesEntry?.value || !ceoEntry?.value) {
        return { error: '订单评审会必须业务和 CEO 双方都勾选才能完成' };
      }
      if (salesEntry.updated_by && ceoEntry.updated_by && salesEntry.updated_by === ceoEntry.updated_by) {
        return { error: '订单评审会双签必须由两个不同账号操作（业务 + CEO 不能是同一人）' };
      }
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

  // 逾期允许直接处理（CEO 拍板 2026-04-08）：
  // 不再强制先提交延期申请。逾期天数会被记录到 milestone_logs 用于后续评分扣分，
  // 同时 UI 会标注「逾期 X 天完成」让 CEO/督导/下游负责人都能看到。
  // 计算逾期天数留到 mark_done 之后写日志时统一处理。
  const milestoneData_precheck = milestone as any;
  let overdueDays = 0;
  if (milestoneData_precheck.due_at) {
    const dueDate = new Date(milestoneData_precheck.due_at);
    const now = new Date();
    if (now > dueDate) {
      overdueDays = Math.ceil((now.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000));
    }
  }

  // Check if evidence is required and exists（三重检查）
  if (milestone.evidence_required) {
    // 检查1: milestone_id 关联的附件（attachments 表）
    const { data: att1 } = await (supabase.from('attachments') as any)
      .select('id')
      .eq('milestone_id', milestoneId)
      .limit(1);
    // 检查2: milestone_id 关联的附件（order_attachments 表）
    const { data: att2 } = await (supabase.from('order_attachments') as any)
      .select('id')
      .eq('milestone_id', milestoneId)
      .limit(1);
    // 检查3: 按 order_id + file_type 匹配（订单资料区上传的文件）
    const stepToFileType: Record<string, string[]> = {
      po_confirmed: ['customer_po'],
      production_order_upload: ['production_order', 'trims_sheet'], // 包装资料拆分到 packing_method_confirmed
      finance_approval: ['internal_quote', 'customer_quote'],
      processing_fee_confirmed: ['internal_quote'],
      procurement_order_placed: ['procurement_order'],
      mid_qc_check: ['qc_report'],
      final_qc_check: ['qc_report'],
      inspection_release: ['qc_report'],
      packing_method_confirmed: ['packing_requirement'], // 包装资料移到这里
      booking_done: ['packing_list'],
      customs_export: ['packing_list'],
      shipment_execute: ['packing_list'],
      sample_qc: ['qc_report'],
      sample_sent: ['tech_pack'],
    };
    let att3: any[] = [];
    const expectedTypes = stepToFileType[milestone.step_key];
    if (expectedTypes && milestone.order_id) {
      const { data } = await (supabase.from('order_attachments') as any)
        .select('id')
        .eq('order_id', milestone.order_id)
        .in('file_type', expectedTypes)
        .limit(1);
      att3 = data || [];
    }

    // 生产单上传：需要 生产订单 + 原辅料单 两个文件（包装资料可以晚点）
    if (milestone.step_key === 'production_order_upload' && milestone.order_id) {
      const requiredTypes = ['production_order', 'trims_sheet'];
      const missing: string[] = [];
      const typeNames: Record<string, string> = { production_order: '生产订单', trims_sheet: '原辅料单' };
      for (const ft of requiredTypes) {
        const { data: found } = await (supabase.from('order_attachments') as any)
          .select('id')
          .eq('order_id', milestone.order_id)
          .eq('file_type', ft)
          .limit(1);
        if (!found || found.length === 0) missing.push(typeNames[ft] || ft);
      }
      if (missing.length > 0) {
        return { error: `生产单上传需要两个文件：生产订单 + 原辅料单\n缺少：${missing.join('、')}\n（包装资料可以晚些上传，最晚在「包装方式确认」前 1 周）` };
      }
    } else {
      const hasEvidence = (att1 && att1.length > 0) || (att2 && att2.length > 0) || att3.length > 0;
      if (!hasEvidence) {
        const typeHint = expectedTypes ? `（需要：${expectedTypes.join(' 或 ')}）` : '';
        return { error: `此节点需要上传凭证后才能标记完成${typeHint}，请先上传对应文件` };
      }
    }
  }
  
  // 凭证已上传通过，直接强制完成（绕过状态机和依赖检查）
  // 数据库 enum 用英文：pending, in_progress, done, blocked, overdue
  const { data: directUpdate, error: directErr } = await (supabase.from('milestones') as any)
    .update({
      status: 'done',
      actual_at: new Date().toISOString(),
    })
    .eq('id', milestoneId)
    .select('*')
    .single();

  if (directErr || !directUpdate) {
    return { error: directErr?.message || '节点状态更新失败，请重试' };
  }

  // 写入操作日志（包含逾期天数，供后续评分使用）
  await (supabase.from('milestone_logs') as any).insert({
    milestone_id: milestoneId,
    order_id: milestone.order_id,
    actor_user_id: user.id,
    action: 'mark_done',
    note: overdueDays > 0
      ? `凭证已上传，完成时已逾期 ${overdueDays} 天`
      : '凭证已上传，按时完成',
    payload: overdueDays > 0 ? { overdue_days: overdueDays } : null,
  });

  // 逾期完成 → 给订单负责人 + admin 发提醒（让 CEO/督导都看到）
  if (overdueDays > 0) {
    try {
      const { data: orderForNotif } = await (supabase.from('orders') as any)
        .select('order_no, customer_name, owner_user_id, created_by')
        .eq('id', milestone.order_id)
        .single();
      if (orderForNotif) {
        const targets = new Set<string>();
        if (orderForNotif.owner_user_id) targets.add(orderForNotif.owner_user_id);
        if (orderForNotif.created_by && orderForNotif.created_by !== user.id) {
          targets.add(orderForNotif.created_by);
        }
        // 也通知 admin 们
        const { data: admins } = await (supabase.from('profiles') as any)
          .select('user_id, role, roles')
          .or('role.eq.admin,roles.cs.{admin}');
        for (const a of admins || []) {
          if (a.user_id !== user.id) targets.add(a.user_id);
        }

        const title = `⏰ 节点逾期 ${overdueDays} 天完成 — ${orderForNotif.order_no}`;
        const message = `${orderForNotif.customer_name} 订单的「${(milestone as any).name}」已完成，但比计划晚 ${overdueDays} 天。会进入订单评分。`;
        for (const userId of targets) {
          await (supabase.from('notifications') as any).insert({
            user_id: userId,
            type: 'milestone_overdue_done',
            title,
            message,
            related_order_id: milestone.order_id,
            related_milestone_id: milestoneId,
          });
        }
      }
    } catch (notifErr: any) {
      console.error('[overdue notify] failed:', notifErr?.message);
    }
  }

  const updatedMilestone = directUpdate;
  const milestoneData = milestone as any;

  // 财务审核完成 → 动态更新"生产单上传"截止日为 now + 2 工作日
  if (milestoneData.step_key === 'finance_approval') {
    const newDue = ensureBusinessDay(addWorkingDays(new Date(), 2));
    await (supabase.from('milestones') as any)
      .update({ due_at: newDue.toISOString() })
      .eq('order_id', milestoneData.order_id)
      .eq('step_key', 'production_order_upload');
  }

  // ── 用户输入日期覆盖下游节点 due_at ──
  // BOM 预评估完成 → 用 fabric_order_date / expected_arrival_date 覆盖下游
  // 生产预评估完成 → 用 production_line_start_date 覆盖 production_kickoff
  if (
    milestoneData.step_key === 'order_docs_bom_complete' ||
    milestoneData.step_key === 'bulk_materials_confirmed'
  ) {
    try {
      await applyChecklistDateOverrides(supabase, milestoneData.order_id, milestoneData.step_key);
    } catch (overrideErr: any) {
      console.error('[applyChecklistDateOverrides] failed:', overrideErr?.message);
      // 失败不阻断主流程
    }
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

  // ── 采购下单完成 → 自动校验采购数量 vs 成本基线预算 ──
  // CEO 2026-04-09：超预算 5% 通知责任人+财务+CEO
  if (milestoneData.step_key === 'procurement_order_placed') {
    try {
      const { getCostControlSummary, sendCostAlert } = await import('@/app/actions/cost-control');
      const costRes = await getCostControlSummary(milestoneData.order_id);
      if (costRes.data?.alerts) {
        for (const alert of costRes.data.alerts) {
          if (alert.level === 'red') {
            await sendCostAlert(
              milestoneData.order_id,
              alert.title.includes('面料') ? 'procurement_over_budget' : 'cmt_over_estimate',
              `${orderForNotif?.order_no || '?'}: ${alert.message}`,
              milestoneData.owner_user_id || undefined,
            );
          }
        }
      }
    } catch (costErr: any) {
      console.warn('[markMilestoneDone] cost control check failed:', costErr?.message);
    }
  }

  // ── 剩余物料回收完成 → 计算真实单耗 → 写入基线 + 反哺 Quoter RAG ──
  if (milestoneData.step_key === 'leftover_collection') {
    try {
      // 读取该订单的采购到货 + 剩余物料备注 → 计算真实用量
      const { data: procItems } = await (supabase.from('procurement_line_items') as any)
        .select('received_qty, category')
        .eq('order_id', milestoneData.order_id)
        .eq('category', 'fabric')
        .not('received_qty', 'is', null);

      const { data: orderForCalc } = await (supabase.from('orders') as any)
        .select('quantity, style_no, customer_name, order_no')
        .eq('id', milestoneData.order_id)
        .single();

      if (procItems && procItems.length > 0 && orderForCalc?.quantity > 0) {
        const totalReceivedKg = (procItems as any[]).reduce((s, i) => s + (i.received_qty || 0), 0);
        // 真实单耗 ≈ 到货量 / 订单数量（简化：假设剩余物料在备注里，后续可以精确化）
        const actualConsumptionKg = Number((totalReceivedKg / orderForCalc.quantity).toFixed(4));

        // 写入基线
        await (supabase.from('order_cost_baseline') as any)
          .update({
            actual_fabric_used_kg: totalReceivedKg,
            actual_consumption_kg: actualConsumptionKg,
            updated_at: new Date().toISOString(),
          })
          .eq('order_id', milestoneData.order_id);

        // 反哺 Quoter RAG — 写入 quoter_fabric_records
        if (actualConsumptionKg > 0) {
          await (supabase.from('quoter_fabric_records') as any).insert({
            garment_type: 'knit_bottom', // 默认，后续可从订单获取
            style_no: orderForCalc.style_no || null,
            customer_name: orderForCalc.customer_name || null,
            consumption_kg: actualConsumptionKg,
            consumption_source: 'actual_production',
            notes: `${orderForCalc.order_no} 实际生产数据（${orderForCalc.quantity}件，到货 ${totalReceivedKg}KG）`,
          });
          console.log(`[markMilestoneDone] 真实单耗已反哺 RAG: ${actualConsumptionKg} KG/件`);
        }
      }
    } catch (calcErr: any) {
      console.warn('[markMilestoneDone] 核销计算失败（不影响节点完成）:', calcErr?.message);
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

  // 如果是财务相关里程碑，推送到财务系统
  if (['finance', 'cashier'].includes(milestoneData.owner_role)) {
    try {
      const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
      const { data: orderData } = await (supabase.from('orders') as any).select('*').eq('id', milestoneData.order_id).single();
      if (orderData) await syncOrderToFinance(orderData, 'order.updated');
    } catch {}
  }

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

  // 角色解析
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdminUser = userRoles.includes('admin');
  // 生命周期校验（管理员可强制）
  const lifecycleErr = await checkOrderModifiable(supabase, milestone.order_id, isAdminUser);
  if (lifecycleErr) return { error: lifecycleErr };

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

/**
 * 用户在预评估节点填的日期 → 覆盖下游节点的 due_at
 *
 * BOM 预评估 (order_docs_bom_complete):
 *   - fabric_order_date     → procurement_order_placed.due_at
 *   - expected_arrival_date → materials_received_inspected.due_at
 *
 * 生产预评估 (bulk_materials_confirmed):
 *   - production_line_start_date → production_kickoff.due_at
 *
 * 修改时同时记日志。失败不影响主流程。
 */
async function applyChecklistDateOverrides(
  supabase: any,
  orderId: string,
  stepKey: 'order_docs_bom_complete' | 'bulk_materials_confirmed',
): Promise<void> {
  // 读取该节点的 checklist_data
  const { data: ms } = await (supabase.from('milestones') as any)
    .select('checklist_data')
    .eq('order_id', orderId)
    .eq('step_key', stepKey)
    .single();
  if (!ms || !Array.isArray(ms.checklist_data)) return;

  const responses = ms.checklist_data as Array<{ key: string; value: any; pending_date?: string }>;
  const getDate = (key: string): string | null => {
    const r = responses.find(x => x.key === key);
    if (!r) return null;
    return r.pending_date || (typeof r.value === 'string' ? r.value : null);
  };

  // 节点 → 用户日期 的映射
  const overrideMap: Array<{ targetStep: string; date: string | null; sourceLabel: string }> = [];

  if (stepKey === 'order_docs_bom_complete') {
    overrideMap.push(
      { targetStep: 'procurement_order_placed', date: getDate('fabric_order_date'), sourceLabel: '布料下单日期' },
      { targetStep: 'materials_received_inspected', date: getDate('expected_arrival_date'), sourceLabel: '预计到料日期' },
    );
  } else if (stepKey === 'bulk_materials_confirmed') {
    overrideMap.push(
      { targetStep: 'production_kickoff', date: getDate('production_line_start_date'), sourceLabel: '预计上线日期' },
    );
  }

  for (const { targetStep, date, sourceLabel } of overrideMap) {
    if (!date) continue;
    // 解析为 ISO；用 23:59:59 让"当天截止"
    let isoDate: string;
    try {
      const d = new Date(date + 'T23:59:59+08:00');
      if (isNaN(d.getTime())) continue;
      isoDate = d.toISOString();
    } catch {
      continue;
    }

    // 仅更新未完成的节点（不破坏已完成数据）
    const { data: target } = await (supabase.from('milestones') as any)
      .select('id, status, due_at')
      .eq('order_id', orderId)
      .eq('step_key', targetStep)
      .single();
    if (!target) continue;
    const status = String(target.status || '').toLowerCase();
    if (status === 'done' || status === '已完成') continue;

    await (supabase.from('milestones') as any)
      .update({ due_at: isoDate, planned_at: isoDate })
      .eq('id', target.id);

    // 写日志
    await (supabase.from('milestone_logs') as any).insert({
      milestone_id: target.id,
      order_id: orderId,
      action: 'recalc_schedule',
      note: `按用户输入「${sourceLabel}」更新截止日为 ${date}`,
      payload: { source_step: stepKey, source_field: sourceLabel, new_due_at: isoDate },
    });
  }
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

  // 生命周期校验（管理员可强制）
  if (milestone) {
    const { data: profileLc } = await supabase
      .from('profiles').select('role, roles').eq('user_id', user.id).single();
    const lcRoles: string[] = (profileLc as any)?.roles?.length > 0 ? (profileLc as any).roles : [(profileLc as any)?.role].filter(Boolean);
    const lcErr = await checkOrderModifiable(supabase, (milestone as any).order_id, lcRoles.includes('admin'));
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

  // admin + production_manager 可以指定执行人
  // CEO 2026-04-09：生产主管需要能指定跟单
  if (!userRoles.includes('admin') && !userRoles.includes('production_manager')) {
    return { error: '只有管理员或生产主管可以指定执行人' };
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

  // 角色与授权：admin / finance / production_manager / admin_assistant
  // 订单创建者 / 跟单负责人 / 该节点的执行人 均可解除卡住
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  const isAdmin = userRoles.includes('admin');
  const isPrivileged = isAdmin || userRoles.some((r: string) =>
    ['finance', 'production_manager', 'admin_assistant'].includes(r));

  // 拿到该节点 + 订单所有权信息
  const { data: msForCheck } = await (supabase.from('milestones') as any)
    .select('order_id, owner_user_id, status')
    .eq('id', milestoneId)
    .single();
  if (!msForCheck) return { error: '节点不存在' };

  let allowed = isPrivileged;
  if (!allowed) {
    const { data: order } = await (supabase.from('orders') as any)
      .select('created_by, owner_user_id')
      .eq('id', msForCheck.order_id)
      .single();
    if (order) {
      if (order.created_by === user.id) allowed = true;
      else if (order.owner_user_id === user.id) allowed = true;
      else if (msForCheck.owner_user_id === user.id) allowed = true;
    }
  }
  if (!allowed) {
    return { error: '无权操作：仅管理员 / 订单创建者 / 跟单 / 节点执行人可解除卡住' };
  }

  // 生命周期校验（非 admin 也按非强制走标准校验）
  const lcErr = await checkOrderModifiable(supabase, msForCheck.order_id, isAdmin);
  if (lcErr) return { error: lcErr };

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

  // 权限：关卡负责人 / 角色匹配 / 管理员（管理员可补录历史数据）
  const { data: dateProfile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const dateUserRoles: string[] = (dateProfile as any)?.roles?.length > 0 ? (dateProfile as any).roles : [(dateProfile as any)?.role].filter(Boolean);
  const isDateAdmin = dateUserRoles.includes('admin');
  const isDateAssigned = milestone.owner_user_id === user.id;
  const dateRoleMatches = milestone.owner_role && dateUserRoles.some(
    (r: string) => r.toLowerCase() === milestone.owner_role.toLowerCase()
      || (milestone.owner_role === 'sales' && r === 'merchandiser')
      || (milestone.owner_role === 'merchandiser' && r === 'sales')
  );
  if (!isDateAdmin && !isDateAssigned && !dateRoleMatches) {
    return { error: '仅对应角色的负责人或管理员可填写实际日期' };
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
  if (!userRoles.includes('admin') && !userRoles.includes('production_manager')) {
    return { error: '只有管理员或生产主管可以指定执行人' };
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

  // 权限：管理员 / 生产主管 / 订单创建者
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdmin = userRoles.includes('admin');
  const isPM = userRoles.includes('production_manager');

  if (!isAdmin && !isPM) {
    const { data: order } = await (supabase.from('orders') as any)
      .select('owner_user_id')
      .eq('id', orderId)
      .single();
    if (!order || order.owner_user_id !== user.id) {
      return { error: '只有管理员、生产主管或订单负责人可以指定跟单' };
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

  // 批量更新 — 排除生产主管固定节点（工厂匹配确认 + 产前样准备完成）
  // CEO 2026-04-09：这两个节点永远绑定生产主管，指派跟单时不能覆盖
  const { PRODUCTION_MANAGER_FIXED_STEPS } = await import('@/lib/domain/default-assignees');

  // 先查出所有该订单的 merchandiser 节点
  const { data: allMerchMs } = await (supabase.from('milestones') as any)
    .select('id, step_key')
    .eq('order_id', orderId)
    .eq('owner_role', 'merchandiser');

  // 过滤掉生产主管固定节点
  const pmFixedSet = new Set(PRODUCTION_MANAGER_FIXED_STEPS);
  const toUpdate = ((allMerchMs || []) as any[])
    .filter(m => !pmFixedSet.has(m.step_key))
    .map(m => m.id);

  let updated: any[] = [];
  if (toUpdate.length > 0) {
    const { data: upd, error: updateErr } = await (supabase.from('milestones') as any)
      .update({ owner_user_id: merchandiserUserId })
      .in('id', toUpdate)
      .select('id');
    if (updateErr) return { error: updateErr.message };
    updated = upd || [];
  }

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

  // 角色解析（先读，给生命周期校验和检查项校验复用）
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const isAdminUserCl = userRoles.includes('admin');

  // 生命周期校验（管理员可强制）
  const lcErr = await checkOrderModifiable(supabase, milestone.order_id, isAdminUserCl);
  if (lcErr) return { error: lcErr };

  // 角色校验：只能编辑自己角色对应的检查项（管理员一般不受限）
  // 例外：order_kickoff_meeting 的双签字段强制角色匹配，admin 也不能替代 sales
  const { getChecklistForStep } = await import('@/lib/domain/checklist');
  const checklistConfig = getChecklistForStep(milestone.step_key);
  const STRICT_ROLE_FIELDS: Record<string, string[]> = {
    order_kickoff_meeting: ['sales_signed', 'ceo_signed'],
  };
  const strictKeys = STRICT_ROLE_FIELDS[milestone.step_key] || [];
  if (checklistConfig) {
    for (const r of responses) {
      const itemDef = checklistConfig.items.find((i: any) => i.key === r.key);
      if (!itemDef) continue;

      const isStrict = strictKeys.includes(r.key);
      const requiredRole = itemDef.role.toLowerCase();
      const userHasRole = userRoles.some((ur: string) => ur.toLowerCase() === requiredRole);

      // 严格双签字段：必须真的有对应角色，admin 不能代替 sales
      if (isStrict && !userHasRole) {
        return { error: `无权编辑「${itemDef.label}」— 必须由 ${itemDef.role} 角色本人勾选` };
      }
      // 普通字段：admin 可以代任何角色
      if (!isStrict && !isAdminUserCl && !userHasRole) {
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
