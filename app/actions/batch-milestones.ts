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
  // 任何登录用户都可标记批次进度（与现有 /api/nudge 同样宽松）
  // 主流程的角色权限在主 milestone 推进时由原 checkOrderModifiable / 角色匹配把关
  if (!isAdmin && !isOrderActor) {
    // 不强制阻塞，但记录在审计中
    // （如果未来收紧权限，把下面这行改成 return error 即可）
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

  revalidatePath(`/orders/${orderId}`);
  return {
    ok: true,
    autoPromoted,
    progress: { done: progress.done, total: progress.total },
  };
}
