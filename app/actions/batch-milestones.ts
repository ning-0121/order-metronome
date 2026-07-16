'use server';

/**
 * Batch Milestone Actions — 分批出货节点的批次级操作
 *
 * 设计：
 *   - 业务/物流/财务等角色为各自负责的节点按批次打勾完成
 *   - 当所有批次都完成给定节点 → 系统自动把订单级 milestone 标为 done
 *   - 部分完成时主 milestone 保持 in_progress
 *
 * 权限：
 *   - 调用方必须是订单相关人员（owner/created_by/admin）
 *   - 跨角色操作允许（与主流程的「跨角色不阻塞」一致）
 *
 * 审计：
 *   - 每次批次状态变更写 milestone_logs（action='batch_step_marked'）
 *   - 自动晋升主 milestone 也写 milestone_logs（action='auto_promote_from_batches'）
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  isBatchAwareStep,
  computeBatchProgress,
  BATCH_STEP_META,
  type BatchAwareStepKey,
} from '@/lib/domain/batchAwareSteps';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { fireRuntimeRecompute } from '@/lib/repositories/milestonesRepo';
import { syncShippingDocsToFinance } from '@/app/actions/shipping-docs-sync';

export interface MarkBatchStepResult {
  ok: boolean;
  error?: string;
  /** 主 milestone 是否被自动晋升为 done */
  autoPromoted?: boolean;
  /** 批次完成度 */
  progress?: { done: number; total: number };
}

/**
 * 标记/取消标记一个批次的某节点完成
 *
 * @param batchId shipment_batches.id
 * @param stepKey BATCH_AWARE_STEP_KEYS 中的某一项
 * @param action 'complete' = 标记完成 / 'undo' = 撤销
 * @param meta 当 stepKey='shipment_execute' 时可以同时录入 BL / 船名 / 实际出货日
 */
export async function markBatchMilestoneStep(
  batchId: string,
  stepKey: string,
  action: 'complete' | 'undo',
  meta?: { actual_ship_date?: string; bl_number?: string; vessel_name?: string; tracking_no?: string; notes?: string },
): Promise<MarkBatchStepResult> {
  if (!isBatchAwareStep(stepKey)) {
    return { ok: false, error: `${stepKey} 不是分批感知节点` };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '未登录' };

  // 读取批次和订单
  const { data: batch, error: batchErr } = await (supabase.from('shipment_batches') as any)
    .select('*, orders!inner(id, order_no, lifecycle_status, created_by, owner_user_id)')
    .eq('id', batchId)
    .single();

  if (batchErr || !batch) {
    return { ok: false, error: batchErr?.message || '批次不存在' };
  }

  const order = batch.orders;
  const orderId: string = order.id;

  // 鉴权：admin / 订单创建者 / owner（保持宽松，符合"跨角色不阻塞"原则）
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');
  const isOrderActor = order.created_by === user.id || order.owner_user_id === user.id;
  // 鉴权(审计 P0:此前是空 no-op,任意登录用户可驱动批次节点含出运放货)。
  // 放行:admin / 订单负责人 / 可操作里程碑的角色(跟单/生产/QC/物流等)。
  const canOperate = isAdmin || isOrderActor
    || hasRoleInGroup(roles, 'CAN_OPERATE_MILESTONES') || roles.includes('logistics');
  if (!canOperate) return { ok: false, error: '无权操作该批次节点' };
  // 出运放货(shipment_execute:写 BL/船名/置 shipped)额外闸:仅物流/生产管理/订单负责人/admin
  if (BATCH_STEP_META[stepKey as BatchAwareStepKey]?.source === 'status_shipped' && action === 'complete') {
    const canShip = isAdmin || isOrderActor
      || roles.includes('logistics') || roles.includes('production_manager');
    if (!canShip) return { ok: false, error: '仅物流/生产管理/订单负责人可标记出运' };
    const { getShipmentReleaseGate } = await import('@/app/actions/shipment-release');
    const gate = await getShipmentReleaseGate(orderId);
    if (gate.error) return { ok: false, error: gate.error };
    if (!gate.data?.allowed) {
      return { ok: false, error: `出货条件未满足：${gate.data?.blockers.map((b) => `${b.label}（${b.nextAction}）`).join('；')}` };
    }

    // 分批明细强化(2026-07-06 用户拍板:7月起"有明细"的单,分批出运必须填款色明细)——
    // 订单有逐款逐色明细(order_line_items)但本批未填款色明细(shipment_batch_items)→ 拦。
    // 老订单(无明细)不受限;shipment_batch_items 表缺失时不阻断(降级放行)。
    const { count: liCount } = await (supabase.from('order_line_items') as any)
      .select('id', { count: 'exact', head: true }).eq('order_id', orderId);
    if ((liCount || 0) > 0) {
      const { count: allocCount, error: allocErr } = await (supabase.from('shipment_batch_items') as any)
        .select('id', { count: 'exact', head: true }).eq('batch_id', batchId);
      if (!allocErr && (allocCount || 0) === 0) {
        return { ok: false, error: '该单有逐款逐色明细,本批出运前请先填「款色明细」(每款每色本批出多少件),再标出运。老订单(无明细)不受此限。' };
      }
    }
  }

  // ── 1. 更新批次本身 ──
  const meta_def = BATCH_STEP_META[stepKey as BatchAwareStepKey];
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };

  if (meta_def.source === 'status_shipped') {
    // shipment_execute：用 status + actual_ship_date
    if (action === 'complete') {
      updates.status = 'shipped';
      updates.actual_ship_date = meta?.actual_ship_date || new Date().toISOString().slice(0, 10);
      if (meta?.bl_number) updates.bl_number = meta.bl_number;
      if (meta?.vessel_name) updates.vessel_name = meta.vessel_name;
      if (meta?.tracking_no) updates.tracking_no = meta.tracking_no;
      if (meta?.notes) updates.notes = meta.notes;
    } else {
      // undo：回滚到 planned
      updates.status = 'planned';
      updates.actual_ship_date = null;
    }
  } else {
    // milestone_progress jsonb
    const currentProgress = batch.milestone_progress || {};
    if (action === 'complete') {
      currentProgress[stepKey] = new Date().toISOString();
    } else {
      currentProgress[stepKey] = null;
    }
    updates.milestone_progress = currentProgress;
  }

  const { error: updErr } = await (supabase.from('shipment_batches') as any)
    .update(updates)
    .eq('id', batchId);

  if (updErr) return { ok: false, error: updErr.message };

  // ── 2. 重新读取所有批次，判断是否全部完成 ──
  const { data: allBatches } = await (supabase.from('shipment_batches') as any)
    .select('id, status, actual_ship_date, milestone_progress')
    .eq('order_id', orderId)
    .order('batch_no');

  const batches = (allBatches as any[]) || [];
  const progress = computeBatchProgress(batches, stepKey as BatchAwareStepKey);

  // ── 3. 自动晋升/降级主 milestone ──
  let autoPromoted = false;
  const { data: mainMilestone } = await (supabase.from('milestones') as any)
    .select('id, status')
    .eq('order_id', orderId)
    .eq('step_key', stepKey)
    .maybeSingle();

  if (mainMilestone) {
    const currentMainStatus = String(mainMilestone.status || '').toLowerCase();
    if (progress.allDone && action === 'complete' && currentMainStatus !== 'done') {
      // 全部完成 → mark done
      await (supabase.from('milestones') as any)
        .update({
          status: 'done',
          actual_at: new Date().toISOString(),
        })
        .eq('id', mainMilestone.id);
      autoPromoted = true;

      await (supabase.from('milestone_logs') as any).insert({
        milestone_id: mainMilestone.id,
        order_id: orderId,
        actor_user_id: user.id,
        action: 'auto_promote_from_batches',
        from_status: currentMainStatus,
        to_status: 'done',
        note: `所有 ${progress.total} 批均已完成此节点，系统自动标完`,
      });
    } else if (!progress.allDone && currentMainStatus === 'done' && action === 'undo') {
      // 撤销后不再全部完成 → 回退到 in_progress
      await (supabase.from('milestones') as any)
        .update({
          status: 'in_progress',
          actual_at: null,
        })
        .eq('id', mainMilestone.id);

      await (supabase.from('milestone_logs') as any).insert({
        milestone_id: mainMilestone.id,
        order_id: orderId,
        actor_user_id: user.id,
        action: 'auto_demote_from_batches',
        from_status: 'done',
        to_status: 'in_progress',
        note: `撤销某批次完成 → 当前 ${progress.done}/${progress.total} 批已完成，主节点回退到进行中`,
      });
    } else if (!progress.allDone && currentMainStatus === 'pending' && progress.done > 0) {
      // 第一个批次完成 → 主节点从 pending 进 in_progress
      await (supabase.from('milestones') as any)
        .update({ status: 'in_progress' })
        .eq('id', mainMilestone.id);
    }
  }

  // 主节点被批次自动升/降级 → 交付置信度重算(否则关键节点标完/回退后风险卡陈旧;
  // 违反 production-report-milestone-wiring 铁律「任何里程碑状态写入路径都必须调它」)。fire-and-forget。
  if (mainMilestone) {
    fireRuntimeRecompute(orderId, {
      type: 'milestone_status_changed', source: `batch:${stepKey}`, severity: 'info',
      payload: { milestone_id: mainMilestone.id, note: 'batch promote/demote' },
    });
  }

  // ── 4. 写批次操作审计 ──
  if (mainMilestone) {
    await (supabase.from('milestone_logs') as any).insert({
      milestone_id: mainMilestone.id,
      order_id: orderId,
      actor_user_id: user.id,
      action: action === 'complete' ? 'batch_step_marked' : 'batch_step_undone',
      note: `批次 #${batch.batch_no} ${meta_def.label}${action === 'complete' ? ' 已标完' : ' 已撤销'}`,
      payload: { batch_id: batchId, batch_no: batch.batch_no, step_key: stepKey, progress },
    });
  }

  // ── 5. 出运完成 → 出货单据同步财务(阶段一,fire-and-forget,永不阻塞出运)──
  //   本批标出运(status_shipped + complete)即推该批的 装箱单/CI/PI/报关 到财务。
  if (meta_def.source === 'status_shipped' && action === 'complete') {
    void syncShippingDocsToFinance(orderId, batchId);   // 不 await:同步内部已吞错,永不阻塞出运
  }

  revalidatePath(`/orders/${orderId}`);
  return {
    ok: true,
    autoPromoted,
    progress: { done: progress.done, total: progress.total },
  };
}
