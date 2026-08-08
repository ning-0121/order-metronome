'use server';

/**
 * 已出货一键完成(2026-07-28 CEO):出厂日已过的订单,业务确认"已出货"→
 * 除收款外的未完成节点全部补录完成(逾期消失);收款已完成/无收款节点 → 订单直接完结,
 * 否则保持执行中(只剩收款,财务照常跟)。有在途分批的单不许走此捷径(防两轨打架)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { writeAuditEvent } from '@/lib/audit/write-audit-event';
import { safeMutation } from '@/lib/db/safe-mutation';
import { revalidatePath } from 'next/cache';

const CAN_CONFIRM = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin', 'admin_assistant'];
const DONE = new Set(['done', 'completed', '已完成']);

export async function confirmOrderShipped(orderId: string): Promise<{ ok: boolean; completed?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles, name').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => CAN_CONFIRM.includes(r))) return { ok: false, error: '仅业务/理单/管理可确认已出货' };

  const svc = createServiceRoleClient();
  const { data: order } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, lifecycle_status, order_purpose').eq('id', orderId).maybeSingle();
  if (!order) return { ok: false, error: '订单不存在' };
  if (['completed', '已完成', 'cancelled', '已取消', 'archived', '已归档'].includes(String(order.lifecycle_status))) {
    return { ok: false, error: '订单已终结,无需确认' };
  }

  // 分批在途护栏(H2 双轨):有未出完的分批 → 必须走分批出货流程逐批确认
  try {
    const { data: batches } = await (svc.from('shipment_batches') as any).select('id, status').eq('order_id', orderId);
    const open = ((batches || []) as any[]).filter((b) => !['shipped', 'completed', 'cancelled', '已出运', '已取消'].includes(String(b.status)));
    if (open.length > 0) return { ok: false, error: `本单有 ${open.length} 个在途分批,请到「出货单据」按批确认出运,不能一键整单完成` };
  } catch { /* 表不存在则无分批,放行 */ }

  const { data: ms } = await (svc.from('milestones') as any)
    .select('id, step_key, status, notes').eq('order_id', orderId);
  const nowIso = new Date().toISOString();
  const actorName = (prof as any)?.name || user.email?.split('@')[0] || '业务';
  const toClose = ((ms || []) as any[]).filter((m) => !DONE.has(String(m.status)) && m.step_key !== 'payment_received');

  // R1-F(S2 修复):一键出货会把出运/订舱节点批量置 done —— 但绝不能绕过发货财务闸。
  // 与 milestones.ts 出运闸同口径:非 admin 时,若含出运/订舱节点且财务未放货(或付款暂停),拒绝。
  const GATE_STEPS = new Set(['shipment_execute', 'booking_done', 'domestic_delivery', 'domestic_shipment']);
  const isAdminActor = roles.includes('admin');
  if (!isAdminActor && toClose.some((m: any) => GATE_STEPS.has(m.step_key))) {
    const { data: fin } = await (svc.from('order_financials') as any)
      .select('allow_shipment, payment_hold').eq('order_id', orderId).maybeSingle();
    if ((fin as any)?.payment_hold === true || (fin as any)?.allow_shipment !== true) {
      return { ok: false, error: '财务尚未放货(或已付款暂停),不能一键出货 —— 请先由财务在出货审批中放行。' };
    }
  }
  for (let i = 0; i < toClose.length; i += 50) {
    const chunk = toClose.slice(i, i + 50).map((m) => m.id);
    const { error } = await (svc.from('milestones') as any)
      .update({ status: 'done', actual_at: nowIso, notes: `[已出货一键补录·${actorName}] 业务确认整单已出货` })
      .in('id', chunk);
    if (error) return { ok: false, error: '节点补录失败:' + error.message };
  }

  const pay = ((ms || []) as any[]).find((m) => m.step_key === 'payment_received');
  const payDone = !pay || DONE.has(String(pay.status));
  if (payDone) {
    // R1-C:completed 写断言 —— 失败还返回 completed:true = 界面说完结、订单还在跑
    const wDone = await safeMutation({ client: svc, table: 'orders', operation: 'update',
      payload: { lifecycle_status: 'completed', updated_at: nowIso }, predicate: { id: orderId } });
    if (!wDone.ok) return { ok: false, error: `订单完结未生效(${wDone.status}):${wDone.error}(节点已补录,可重试)` };
  }
  const ar = await writeAuditEvent({
    eventType: 'confirm_shipped', level: 'A2', riskLevel: 'delivery',
    actor: { actorType: 'user', actorId: user.id },
    entity: { entityType: 'order', entityId: orderId, orderId },
    commandName: 'confirmOrderShipped',
    note: `业务确认已出货:补录 ${toClose.length} 个节点${payDone ? ',订单完结' : ',保留收款跟踪'}`,
    metadata: { closed_milestones: toClose.length, completed: payDone },
  });
  if (!ar.ok) console.error('[confirm-shipped] A2 审计失败 → completed_unverified(admin 已告警)');

  revalidatePath('/orders');
  return { ok: true, completed: payDone };
}
