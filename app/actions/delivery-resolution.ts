'use server';

/**
 * 逾期处置(2026-08-20 CEO:「我们是来进行订单推进的,不只是停在预警上」)。
 *
 * 解决的问题:交期日已过的单在「真超期(要行动)」里只有「详情›」,催工厂/改期/跟客户
 * 一个都点不了。而 delay_requests 改的是**节点 due_at** —— 批了节点不红了,
 * 订单交期照旧过期,红条继续挂着。业务跟客户谈成新交期,系统里没处录。
 *
 * 本模块给每条真超期一个出口。六种处置(CEO 拍板 5 种 + 其他):
 *   reschedule / expedite / discount / abandon / partial_ship / other
 *
 * 每个处置必须产出两样东西,缺一不可:
 *   ① 一个新的交期承诺(或明确终止)  ② 一条留痕(谁决定、客户怎么答复、代价多少)
 * 红条只在两级审批都过、且写回 orders 之后才消失 —— **不能靠"点掉"消失**。
 *
 * 审批:订单经理 → 财务(CEO 指定)。交期承诺与钱都要有人认。
 * 交期真相始终在 orders.factory_date / etd;本表只是决策记录 + 审批载体,不是第二真相源。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export type ResolutionType = 'reschedule' | 'expedite' | 'discount' | 'abandon' | 'partial_ship' | 'other';
export type CostKind = 'air_freight' | 'express_sea' | 'discount' | 'write_off' | 'other';

/** 哪些处置必须给出新交期 —— 换了交期才谈得上"推进",否则红条该继续挂着。 */
const NEEDS_NEW_DATE: ResolutionType[] = ['reschedule', 'partial_ship'];
/** 哪些处置必须落金额(财务口径) —— CEO:快船/打折的成本要落进财务口径。 */
const NEEDS_COST: ResolutionType[] = ['expedite', 'discount'];

const RESOLUTION_LABEL: Record<ResolutionType, string> = {
  reschedule: '客户同意改期', expedite: '快船/空运赶', discount: '打折发货',
  abandon: '弃货/取消', partial_ship: '分批出货', other: '其他',
};

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, roles: [] as string[] };
  // 角色读取走 repository(lint:data-access:业务层不直连 profiles)
  const { getUserRoles } = await import('@/lib/repositories/ordersRepo');
  const roles = await getUserRoles(supabase, user.id);
  return { supabase, user, roles };
}

const CAN_REQUEST = ['admin', 'sales', 'sales_manager', 'merchandiser', 'order_manager'];
const CAN_APPROVE_OM = ['admin', 'order_manager', 'sales_manager'];
const CAN_APPROVE_FIN = ['admin', 'finance'];

/**
 * 发起逾期处置申请。
 * 一张单同时只允许一个未结处置(DB 唯一索引兜底,这里先给人话提示)。
 */
export async function requestDeliveryResolution(orderId: string, input: {
  resolutionType: ResolutionType;
  newFactoryDate?: string | null;
  newEtd?: string | null;
  customerResponse: string;
  customerConfirmedAt?: string | null;
  evidencePath?: string | null;
  costAmount?: number | null;
  costKind?: CostKind | null;
  reason: string;
}): Promise<{ id?: string; error?: string }> {
  const { user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => CAN_REQUEST.includes(r))) return { error: '仅业务/跟单/订单经理/管理员可发起逾期处置' };
  if (!input.resolutionType) return { error: '请选择处置方式' };
  if (!input.customerResponse?.trim()) return { error: '请填写客户答复 —— 跟客户谈过必须留痕,不能只有口头' };
  if (!input.reason?.trim()) return { error: '请说明为什么选这个处置' };

  // 处置必须产出「新交期承诺」或「明确终止」,否则等于什么都没解决
  if (NEEDS_NEW_DATE.includes(input.resolutionType) && !input.newFactoryDate && !input.newEtd) {
    return { error: `「${RESOLUTION_LABEL[input.resolutionType]}」必须给出新的出厂日或 ETD —— 没有新交期就不算处置` };
  }
  if (NEEDS_COST.includes(input.resolutionType) && !(Number(input.costAmount) > 0)) {
    return { error: `「${RESOLUTION_LABEL[input.resolutionType]}」必须填写金额(运费/折让)—— 代价要落进财务口径` };
  }

  const repo = await import('@/lib/repositories/deliveryResolutionsRepo');
  const { order, error: oErr } = await repo.readOrderBrief(orderId);
  if (oErr) return { error: `读取订单失败:${oErr}` };
  if (!order) return { error: '订单不存在' };

  const ins = await repo.insertResolution({
    orderId, resolutionType: input.resolutionType,
    newFactoryDate: input.newFactoryDate || null, newEtd: input.newEtd || null,
    customerResponse: input.customerResponse.trim(),
    customerConfirmedAt: input.customerConfirmedAt || null,
    evidencePath: input.evidencePath || null,
    costAmount: input.costAmount != null ? Number(input.costAmount) : null,
    costKind: input.costKind || null,
    reason: input.reason.trim(), requestedBy: user.id,
  });
  if (ins.error || !ins.id) {
    if (ins.conflict) return { error: '本单已有一个待审批的处置申请,请先等它批完或撤回' };
    return { error: `发起失败:${ins.error}` };
  }
  const id = ins.id;
  const svc = createServiceRoleClient();
  const ref = order.ref;
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(svc, ['order_manager', 'sales_manager', 'admin'], {
      type: 'delivery_resolution', title: `🚦 逾期处置待审批:${ref}`,
      message: `${ref}(${order.customerName || '?'})申请「${RESOLUTION_LABEL[input.resolutionType]}」。`
        + `客户答复:${input.customerResponse.trim().slice(0, 60)}。请订单经理先审。`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[deliveryResolution] 通知订单经理失败(不阻断):', e?.message); }

  try {
    const { writeAuditEvent } = await import('@/lib/audit/write-audit-event');
    await writeAuditEvent({
      eventType: 'delivery_resolution_requested', level: 'A2', riskLevel: 'delivery',
      actor: { actorType: 'user', actorId: user.id },
      entity: { entityType: 'order', entityId: orderId, orderId },
      commandName: 'requestDeliveryResolution',
      reason: input.reason.trim(),
      afterState: {
        resolution_type: input.resolutionType, new_factory_date: input.newFactoryDate || null,
        new_etd: input.newEtd || null, cost_amount: input.costAmount ?? null,
      },
    } as any);
  } catch { /* 审计失败不回滚业务 */ }

  revalidatePath(`/orders/${orderId}`);
  return { id };
}

/**
 * 审批(两级)。订单经理先过 → 财务再过 → 才写回订单交期。
 * decision='reject' 任一级都可驳回。
 */
export async function decideDeliveryResolution(
  resolutionId: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<{ ok?: boolean; stage?: string; error?: string }> {
  const { user, roles } = await auth();
  if (!user) return { error: '请先登录' };

  const svc = createServiceRoleClient();
  const repo = await import('@/lib/repositories/deliveryResolutionsRepo');
  const { row: r, error: rErr } = await repo.readResolution(resolutionId);
  if (rErr) return { error: `读取失败:${rErr}` };
  if (!r) return { error: '处置申请不存在' };
  const row = r as any;
  if (row.status === 'approved' || row.status === 'rejected') {
    return { error: `该申请已${row.status === 'approved' ? '批准' : '驳回'},无需重复处理` };
  }

  const now = new Date().toISOString();
  if (decision === 'reject') {
    if (!roles.some((x) => [...CAN_APPROVE_OM, ...CAN_APPROVE_FIN].includes(x))) return { error: '无权驳回' };
    const rej = await repo.advanceResolutionStatus(resolutionId, ['pending', 'om_approved'],
      { status: 'rejected', rejected_by: user.id, rejected_at: now, reject_reason: note || null });
    if (!rej.ok) return { error: rej.error || '驳回失败' };
    await notifyRequester(row, '❌ 逾期处置被驳回', note || '未说明原因');
    revalidatePath(`/orders/${row.order_id}`);
    return { ok: true, stage: 'rejected' };
  }

  // ── 第一级:订单经理 ──
  if (row.status === 'pending') {
    if (!roles.some((x) => CAN_APPROVE_OM.includes(x))) return { error: '此阶段需订单经理/业务经理审批' };
    const om = await repo.advanceResolutionStatus(resolutionId, ['pending'],
      { status: 'om_approved', om_approved_by: user.id, om_approved_at: now, om_note: note || null });
    if (!om.ok) return { error: om.error || '审批失败' };
    try {
      const { notifyUsersByRole } = await import('@/lib/utils/notifications');
      await notifyUsersByRole(svc, ['finance', 'admin'], {
        type: 'delivery_resolution', title: `🚦 逾期处置待财务审批`,
        message: `订单经理已批「${RESOLUTION_LABEL[row.resolution_type as ResolutionType]}」。`
          + (row.cost_amount ? `涉及金额 ¥${Number(row.cost_amount).toLocaleString()}。` : '')
          + '请财务确认后生效。',
        relatedOrderId: row.order_id,
      });
    } catch { /* 不阻断 */ }
    revalidatePath(`/orders/${row.order_id}`);
    return { ok: true, stage: 'om_approved' };
  }

  // ── 第二级:财务 → 批准即写回订单交期 ──
  if (!roles.some((x) => CAN_APPROVE_FIN.includes(x))) return { error: '此阶段需财务审批' };
  const fin = await repo.advanceResolutionStatus(resolutionId, ['om_approved'],
    { status: 'approved', finance_approved_by: user.id, finance_approved_at: now, finance_note: note || null });
  if (!fin.ok) return { error: fin.error || '审批失败' };

  const applied = await applyResolution(row, user.id);
  revalidatePath(`/orders/${row.order_id}`);
  revalidatePath('/orders');
  return applied.error ? { ok: true, stage: 'approved', error: `已批准,但${applied.error}` } : { ok: true, stage: 'approved' };
}

/**
 * 批准后写回订单 —— 这一步才真正让红条消失。
 * 幂等:applied_at 非空则跳过(防重放/并发重复写)。
 */
async function applyResolution(row: any, actorId: string): Promise<{ error?: string }> {
  if (row.applied_at) return {};
  const repo = await import('@/lib/repositories/deliveryResolutionsRepo');
  const hasDates = !!(row.new_factory_date || row.new_etd);
  let patch: Record<string, any> = {};

  try {
    if (hasDates) {
      const w = await repo.applyOrderDeliveryDates(row.order_id,
        { factoryDate: row.new_factory_date, etd: row.new_etd });
      if (!w.ok) return { error: `写回订单交期失败:${w.error}` };
      patch = w.changed;

      // 交期变了 → 节点排期跟着重算 + 交付置信度重算。
      // 复用 order-amendments 的 recalc_schedule 分支用的同两个入口,不另写一套:
      //   recalcOrderMilestones(节拍器) + recomputeDeliveryConfidence(anchor_changed)。
      // 漏掉后者的话交期改了、风险卡还停在旧锚点上(CLAUDE.md 登记的 4 个 runtime 钩子之一)。
      try {
        const { recalcOrderMilestones } = await import('@/app/actions/recalc-milestones');
        await recalcOrderMilestones(row.order_id);
      } catch { /* 排期重算失败不回滚交期:交期是承诺,节点可再手工调 */ }
      void (async () => {
        try {
          const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
          await recomputeDeliveryConfidence(row.order_id, {
            type: 'anchor_changed',
            source: `delivery_resolution:${row.resolution_type}`,
            severity: 'info',
            payload: { resolution_id: row.id, new_factory_date: row.new_factory_date, new_etd: row.new_etd },
            triggeredBy: actorId,
          });
        } catch (e: any) { console.error('[runtime-hook] delivery_resolution anchor_changed:', e?.message); }
      })();
    }
    await repo.markResolutionApplied(row.id);

    const { writeAuditEvent } = await import('@/lib/audit/write-audit-event');
    await writeAuditEvent({
      eventType: 'delivery_resolution_applied', level: 'A2', riskLevel: 'delivery',
      actor: { actorType: 'user', actorId },
      entity: { entityType: 'order', entityId: row.order_id, orderId: row.order_id },
      commandName: 'decideDeliveryResolution',
      reason: `逾期处置生效:${RESOLUTION_LABEL[row.resolution_type as ResolutionType]}`,
      afterState: patch,
    } as any);
    await notifyRequester(row, '✅ 逾期处置已生效', RESOLUTION_LABEL[row.resolution_type as ResolutionType]);
  } catch (e: any) {
    return { error: `写回过程异常:${e?.message || e}` };
  }
  return {};
}

/** 回执给发起人。insertNotifications 内部自带 service-role(见 notifications 统一入口),不传 client。 */
async function notifyRequester(row: any, title: string, msg: string) {
  try {
    const { insertNotifications } = await import('@/lib/utils/notifications');
    await insertNotifications([{
      user_id: row.requested_by, type: 'delivery_resolution',
      title, message: msg, related_order_id: row.order_id,
    }] as any);
  } catch { /* 通知失败不阻断 */ }
}

/** 某单当前未结的处置申请(给订单页/面板显示状态用)。 */
export async function getOpenResolution(orderId: string): Promise<{ data?: any; error?: string }> {
  const { user } = await auth();
  if (!user) return { error: '请先登录' };
  const { readOpenResolution } = await import('@/lib/repositories/deliveryResolutionsRepo');
  const { row, error } = await readOpenResolution(orderId);
  if (error) return { error };
  return { data: row };
}
