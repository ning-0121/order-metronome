'use server';

/**
 * 订单重排排期 — 当订单未按时上线生产时，重新填写上线日期 + 生产周期，
 * 系统自动推算新的出厂日，并展示对客户要求送达日的影响。
 *
 * 权限：admin 或订单 owner / 订单 created_by
 * 主要场景：年年旺等国内送仓订单出现生产延期，业务员需要快速判断"还来得及不"
 */

import { createClient } from '@/lib/supabase/server';
import { calcDueDates } from '@/lib/schedule';
import { isDoneStatus } from '@/lib/domain/types';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';

export interface ReschedulePreviewItem {
  milestone_id: string;
  step_key: string;
  name: string;
  status: string;
  current_due_at: string | null;
  new_due_at: string | null;
  delta_days: number | null;
}

export interface ReschedulePreviewResult {
  newFactoryDate: string;
  oldFactoryDate: string | null;
  deliveryRequiredAt: string | null;
  bufferDays: number | null; // newFactoryDate → deliveryRequiredAt 缓冲天数
  feasible: boolean;          // 是否仍能按时交付
  feasibleReason: string;
  items: ReschedulePreviewItem[];
}

async function checkAccess(supabase: any, orderId: string): Promise<{ ok: boolean; user?: any; order?: any; reason?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  const { data: order } = await (supabase.from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .single();
  if (!order) return { ok: false, reason: '订单不存在' };

  if (isAdmin) return { ok: true, user, order };
  if (order.owner_user_id === user.id) return { ok: true, user, order };
  if (order.created_by === user.id) return { ok: true, user, order };

  return { ok: false, reason: '仅管理员或订单负责人可重排排期' };
}

/**
 * 预览：根据新上线日期 + 生产周期，预测新出厂日与各节点级联
 * 不写库
 */
export async function previewReschedule(
  orderId: string,
  newProductionStartDate: string,    // YYYY-MM-DD：新的"上线日期"（生产启动）
  productionCycleDays: number,       // 生产周期（天）
): Promise<{ data?: ReschedulePreviewResult; error?: string }> {
  const supabase = await createClient();

  const auth = await checkAccess(supabase, orderId);
  if (!auth.ok) return { error: auth.reason };
  const order = auth.order;

  if (!newProductionStartDate) return { error: '请填写新的上线日期' };
  if (!productionCycleDays || productionCycleDays < 1 || productionCycleDays > 120) {
    return { error: '生产周期请填写 1-120 天之间的数字' };
  }

  // 新出厂日 = 上线日期 + 周期
  const start = new Date(newProductionStartDate);
  if (isNaN(start.getTime())) return { error: '上线日期格式不正确' };
  const newFactoryDate = new Date(start.getTime() + productionCycleDays * 86400000);
  const newFactoryDateStr = newFactoryDate.toISOString().slice(0, 10);

  // 算交付可行性
  const deliveryRequiredAt: string | null = order.delivery_required_at || order.warehouse_due_date || null;
  let bufferDays: number | null = null;
  let feasible = true;
  let feasibleReason = '客户未指定送达日期，可行性无法自动判断';
  if (deliveryRequiredAt) {
    bufferDays = Math.floor(
      (new Date(deliveryRequiredAt).getTime() - newFactoryDate.getTime()) / 86400000,
    );
    if (bufferDays >= 3) {
      feasible = true;
      feasibleReason = `仍能按时交付（剩余 ${bufferDays} 天缓冲）`;
    } else if (bufferDays >= 0) {
      feasible = true;
      feasibleReason = `刚好赶上（仅 ${bufferDays} 天缓冲，建议加急）`;
    } else {
      feasible = false;
      feasibleReason = `将延误 ${Math.abs(bufferDays)} 天，需立即与客户协商`;
    }
  }

  // 用 calcDueDates 重算节点
  const scheduleIncoterm = order.incoterm === 'DDP' ? 'DDP' : 'FOB';
  let dueDates: any;
  try {
    dueDates = calcDueDates({
      orderDate: order.order_date,
      createdAt: new Date(order.created_at),
      incoterm: scheduleIncoterm as 'FOB' | 'DDP',
      etd: order.etd || newFactoryDateStr,
      warehouseDueDate: order.warehouse_due_date,
      eta: order.eta,
      skipPreProductionSample: !!order.skip_pre_production_sample,
      sampleConfirmDaysOverride: order.sample_confirm_days_override ?? null,
    });
  } catch (e: any) {
    return { error: `排期计算失败：${e.message}` };
  }

  // 关键节点用新算法另行覆盖：production_kickoff / factory_completion
  // 简化：把这两个节点直接覆盖为用户指定的日期
  const overrides: Record<string, Date> = {
    production_kickoff: start,
    factory_completion: newFactoryDate,
  };

  // 拉里程碑做对比
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, step_key, name, status, due_at')
    .eq('order_id', orderId)
    .order('sequence_number');

  const items: ReschedulePreviewItem[] = (milestones || []).map((m: any) => {
    const overrideDate = overrides[m.step_key];
    const calcDate: Date | undefined = overrideDate || dueDates[m.step_key as keyof typeof dueDates];
    const newDueIso = calcDate ? calcDate.toISOString() : null;

    let delta: number | null = null;
    if (m.due_at && newDueIso) {
      delta = Math.round(
        (new Date(newDueIso).getTime() - new Date(m.due_at).getTime()) / 86400000,
      );
    }
    return {
      milestone_id: m.id,
      step_key: m.step_key,
      name: m.name,
      status: m.status,
      current_due_at: m.due_at,
      new_due_at: newDueIso,
      delta_days: delta,
    };
  });

  return {
    data: {
      newFactoryDate: newFactoryDateStr,
      oldFactoryDate: order.factory_date,
      deliveryRequiredAt,
      bufferDays,
      feasible,
      feasibleReason,
      items,
    },
  };
}

/**
 * 应用：把预览的结果写入数据库
 * 仅未完成的里程碑会被更新（已完成的保留原 due_at）
 */
export async function applyReschedule(
  orderId: string,
  newProductionStartDate: string,
  productionCycleDays: number,
  note?: string,
): Promise<{ data?: { updatedCount: number; newFactoryDate: string }; error?: string }> {
  const supabase = await createClient();

  const auth = await checkAccess(supabase, orderId);
  if (!auth.ok) return { error: auth.reason };
  const { user, order } = auth;

  const preview = await previewReschedule(orderId, newProductionStartDate, productionCycleDays);
  if (preview.error || !preview.data) return { error: preview.error || '预览失败' };

  const { newFactoryDate, items } = preview.data;

  // 1. 更新订单的 factory_date（FOB/RMB 锚点）+ 在 DDP 情况下不动 etd
  const orderUpdate: Record<string, any> = { factory_date: newFactoryDate };
  await (supabase.from('orders') as any)
    .update(orderUpdate)
    .eq('id', orderId);

  // 2. 更新未完成的里程碑（直接 update，不走 repo 层避免权限误杀）
  let updatedCount = 0;
  for (const item of items) {
    if (isDoneStatus(item.status)) continue;
    if (!item.new_due_at) continue;
    if (item.current_due_at === item.new_due_at) continue;

    const { error: upErr } = await (supabase.from('milestones') as any)
      .update({
        due_at: item.new_due_at,
        planned_at: item.new_due_at,
      })
      .eq('id', item.milestone_id);
    if (!upErr) updatedCount++;
  }

  // 3. 写 order_logs（审计链路）
  await (supabase.from('order_logs') as any).insert({
    order_id: orderId,
    actor_id: user.id,
    action: 'reschedule',
    field_name: 'factory_date',
    old_value: order.factory_date || null,
    new_value: newFactoryDate,
    note: `[重排排期] 新上线日：${newProductionStartDate}，生产周期：${productionCycleDays} 天，更新 ${updatedCount} 个节点。${note?.trim() ? '备注：' + note.trim() : ''}`,
  });

  // ── Runtime Hook 4: amendment 应用 → 异步重算 confidence
  void (async () => {
    try {
      const { recomputeDeliveryConfidence } = await import('./runtime-confidence');
      await recomputeDeliveryConfidence(orderId, {
        type: 'amendment_applied',
        source: 'reschedule-order',
        severity: 'info',
        payload: {
          new_production_start: newProductionStartDate,
          production_cycle_days: productionCycleDays,
          new_factory_date: newFactoryDate,
          milestones_shifted: updatedCount,
          note: note || null,
        },
        triggeredBy: user.id,
      });
    } catch (e: any) {
      console.error('[runtime-hook]', 'amendment_applied hook crashed:', e?.message);
    }
  })();

  revalidatePath(`/orders/${orderId}`);
  return { data: { updatedCount, newFactoryDate } };
}
