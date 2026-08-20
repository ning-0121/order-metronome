'use server';

/**
 * 已出货一键完成(2026-07-28 CEO):出厂日已过的订单,业务确认"已出货"→
 * 除收款外的未完成节点全部补录完成(逾期消失);收款已完成/无收款节点 → 订单直接完结,
 * 否则保持执行中(只剩收款,财务照常跟)。有在途分批的单不许走此捷径(防两轨打架)。
 *
 * ⚠️ 业务语义(2026-08-11 CEO 拍板,钉死):
 *   · 财务批准 = 「可以出」(权限):allow_shipment=true 是放货真相,发生在出货**之前**。
 *   · confirmOrderShipped = 「已经出」(事实):财务未放货**必须拒绝执行**(FINANCE_RELEASE_REQUIRED),
 *     禁止"先出货、后补审批"。不补节点/不改 completed/不发成功通知/不发财务事件。
 *   · 出货真实完成后 → 发 shipment.completed 事实事件给财务(触发应收/CI/结算),≠放货审批请求。
 *   · admin 紧急放行必须走独立显式命令 confirmOrderShippedWithOverride(理由必填 + A2 审计),
 *     普通 confirmOrderShipped 不允许隐式绕过闸。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { writeAuditEvent } from '@/lib/audit/write-audit-event';
import { safeMutation } from '@/lib/db/safe-mutation';
// 出货确认单/放货证据的数据访问收口到 repository(ADR-006 棘轮:业务层不许直接摸表)
import {
  findPendingSalesSigned, hasWarehouseSigned, hasFinanceReleaseLog, createShipmentConfirmationRow,
} from '@/lib/repositories/shipmentConfirmationsRepo';
import { revalidatePath } from 'next/cache';

const CAN_CONFIRM = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin', 'admin_assistant'];
const DONE = new Set(['done', 'completed', '已完成']);

export interface ConfirmShippedResult {
  ok: boolean;
  completed?: boolean;
  error?: string;
  code?: 'FINANCE_RELEASE_REQUIRED' | 'PAYMENT_HOLD' | 'BATCH_OPEN' | 'FORBIDDEN' | 'NOT_FOUND' | 'TERMINAL';
}

/** 普通入口:财务未放货一律拒绝(不隐式绕闸)。 */
export async function confirmOrderShipped(orderId: string): Promise<ConfirmShippedResult> {
  return confirmOrderShippedCore(orderId, { override: null });
}

/** admin 紧急放行入口:理由必填 + A2 审计留痕;仅此显式命令可越过财务放货闸。 */
export async function confirmOrderShippedWithOverride(orderId: string, reason: string): Promise<ConfirmShippedResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录', code: 'FORBIDDEN' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.includes('admin')) return { ok: false, error: '仅管理员可紧急越过财务放货闸', code: 'FORBIDDEN' };
  if (!reason || !reason.trim()) return { ok: false, error: '紧急放行必须填写理由', code: 'FORBIDDEN' };
  return confirmOrderShippedCore(orderId, { override: { reason: reason.trim(), actorId: user.id } });
}

async function confirmOrderShippedCore(
  orderId: string,
  opts: { override: { reason: string; actorId: string } | null },
): Promise<ConfirmShippedResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录', code: 'FORBIDDEN' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles, name').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => CAN_CONFIRM.includes(r))) return { ok: false, error: '仅业务/理单/管理可确认已出货', code: 'FORBIDDEN' };

  const svc = createServiceRoleClient();
  const { data: order } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, lifecycle_status, order_purpose, quantity').eq('id', orderId).maybeSingle();
  if (!order) return { ok: false, error: '订单不存在', code: 'NOT_FOUND' };
  if (['completed', '已完成', 'cancelled', '已取消', 'archived', '已归档'].includes(String(order.lifecycle_status))) {
    return { ok: false, error: '订单已终结,无需确认', code: 'TERMINAL' };
  }

  // 分批在途护栏(H2 双轨):有未出完的分批 → 必须走分批出货流程逐批确认
  try {
    const { data: batches } = await (svc.from('shipment_batches') as any).select('id, status').eq('order_id', orderId);
    const open = ((batches || []) as any[]).filter((b) => !['shipped', 'completed', 'cancelled', '已出运', '已取消'].includes(String(b.status)));
    if (open.length > 0) return { ok: false, error: `本单有 ${open.length} 个在途分批,请到「出货单据」按批确认出运,不能一键整单完成`, code: 'BATCH_OPEN' };
  } catch { /* 表不存在则无分批,放行 */ }

  // ── 财务放货硬闸(所有人一视同仁,无 admin 隐式绕过)──
  // 未放货 → 拒绝,不补节点/不改 completed/不发通知/不发财务事件。admin 紧急放行走 override 命令(已在上游审计)。
  if (!opts.override) {
    const { data: fin } = await (svc.from('order_financials') as any)
      .select('allow_shipment, payment_hold').eq('order_id', orderId).maybeSingle();
    if ((fin as any)?.payment_hold === true) {
      return { ok: false, error: '付款已暂停(payment_hold),不能出货 —— 请先由财务解除暂停。', code: 'PAYMENT_HOLD' };
    }
    // 2026-08-19 修(1022919 实锤):allow_shipment !== true 此前是**死胡同 return** ——
    // 告诉业务「先由财务放行」,却不给财务任何东西(不建确认单/不推财务系统/不通知,零痕迹),
    // 财务任何队列里都看不到这单,业务再点还是同一句话 → 双方永远僵持。
    // 在办单实测 25 张会撞上。修:并入下方「自动转出货财务审批」同一条路(divert),
    // 建 sales_signed 确认单 + 推财务系统 + A2 留痕,让财务真的收到这件事。
    const notAllowed = (fin as any)?.allow_shipment !== true;
    // ── 天生开闸拦截(2026-08-17):补建 order_financials 时 allow_shipment 默认 true(存量 187 单),
    //    闸虽开但财务从未经手 —— 不算放货(CEO 2026-08-11:财务批准发生在出货之前)。
    //    有放货证据(财务系统批过 warehouse_signed / 站内放货 A2 审计)→ 正常放行;
    //    无证据 → 不完结,自动把本次确认转成出货审批推给财务系统,批准后再点一次即可。
    const released = notAllowed ? false : await hasFinanceReleaseEvidence(svc, orderId);
    if (!released) {
      const { exists: pendExists } = await findPendingSalesSigned(svc, orderId);
      if (pendExists) {
        return { ok: false, code: 'FINANCE_RELEASE_REQUIRED', error: '该单出货审批已在财务系统队列中等待批准 —— 财务批准后再点一次「确认已出货」即可完结。' };
      }
      const nowIso = new Date().toISOString();
      const { id: confId, error: confErr } = await createShipmentConfirmationRow(svc, {
        orderId,
        shipmentQty: order.quantity || 0,
        orderQty: order.quantity || null,
        customerName: order.customer_name || null,
        requestedBy: user.id, salesSignId: user.id,
        salesSignedAt: nowIso, status: 'sales_signed',
      });
      if (confErr || !confId) {
        return { ok: false, code: 'FINANCE_RELEASE_REQUIRED', error: '转财务审批失败:' + (confErr || '确认单创建失败') + ' —— 请重试或联系管理员。' };
      }
      const conf = { id: confId };
      const actorName = (prof as any)?.name || user.email?.split('@')[0] || '业务';
      try {
        const { syncShipmentApprovalToFinance } = await import('@/lib/integration/finance-sync');
        // await 原因同 createShipmentConfirmation:serverless 不 await 会被冻结杀掉,财务收不到
        await syncShipmentApprovalToFinance({
          id: conf.id,
          order_no: order.order_no || null,
          customer_name: order.customer_name || null,
          requester_name: actorName,
          summary: `确认已出货转财务审批 ${order.quantity || '?'} 件(${notAllowed ? '财务尚未放货' : '历史单放货闸未经财务确认'})`,
          detail: { internal_order_no: order.internal_order_no || null, shipment_qty: order.quantity || null, source: 'confirm_shipped_diverted' },
          created_at: nowIso,
        } as any);
      } catch (e: any) {
        console.error('[confirm-shipped] 转审批推送失败(确认单已建,outbox 兜底):', e?.message);
      }
      await writeAuditEvent({
        eventType: 'confirm_shipped_diverted', level: 'A2', riskLevel: 'delivery',
        actor: { actorType: 'user', actorId: user.id },
        entity: { entityType: 'order', entityId: orderId, orderId },
        commandName: 'confirmOrderShipped',
        note: `确认已出货被拦截转财务审批:${notAllowed ? '财务尚未放货(allow_shipment≠true)' : '放货闸系补建默认开,无财务放货证据'}(确认单 ${String(conf.id).slice(0, 8)})`,
        metadata: { shipment_confirmation_id: conf.id },
      });
      return { ok: false, code: 'FINANCE_RELEASE_REQUIRED', error: `${notAllowed ? '财务尚未放货' : '该单的放货从未经财务确认(历史默认开闸)'} —— 已自动转入财务审批队列(财务在待审批中心/出货页签可批),批准后再点一次「确认已出货」即可完结。` };
    }
  } else {
    // override 路径:先把「越闸」这件事本身 A2 留痕(理由必填),再继续。
    await writeAuditEvent({
      eventType: 'shipment_release_override', level: 'A2', riskLevel: 'delivery',
      actor: { actorType: 'user', actorId: opts.override.actorId },
      entity: { entityType: 'order', entityId: orderId, orderId },
      commandName: 'confirmOrderShippedWithOverride',
      reason: opts.override.reason, note: 'admin 紧急越过财务放货闸一键出货',
      beforeState: { finance_gate: 'not_released' }, afterState: { finance_gate: 'overridden' },
    });
  }

  const { data: ms } = await (svc.from('milestones') as any)
    .select('id, step_key, status, notes').eq('order_id', orderId);
  const nowIso = new Date().toISOString();
  const actorName = (prof as any)?.name || user.email?.split('@')[0] || '业务';
  const toClose = ((ms || []) as any[]).filter((m) => !DONE.has(String(m.status)) && m.step_key !== 'payment_received');

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
    note: `业务确认已出货:补录 ${toClose.length} 个节点${payDone ? ',订单完结' : ',保留收款跟踪'}${opts.override ? '(admin override)' : ''}`,
    metadata: { closed_milestones: toClose.length, completed: payDone, override: !!opts.override },
  });
  if (!ar.ok) console.error('[confirm-shipped] A2 审计失败 → completed_unverified(admin 已告警)');

  // ── 出货完成 → 发【事实事件】shipment.completed 给财务(触发应收/CI/结算)──
  // 幂等键 = shipment_completed:<orderId>;首发失败自动落 outbox 重试(非 silent,dead 有企微告警)。
  try {
    const { notifyShipmentCompleted } = await import('@/lib/integration/finance-sync');
    const r = await notifyShipmentCompleted({
      order_id: orderId,
      internal_order_no: order.internal_order_no || order.order_no || null,
      shipment_date: nowIso.slice(0, 10),   // 日期串,勿传全精度(保幂等)
      quantity: order.quantity ?? null,
      triggered_by: actorName,
    });
    if (!r.success) console.error(`[confirm-shipped] shipment.completed 首发失败(${r.error}) → 已落 outbox 待重试`);
    // P0-3(审计 2026-08-19):此路只发过事实事件,CI 金额/出货单据从来不推——财务拿到「出货了」
    // 却拿不到应收金额。补齐,与分批/三方会签路径同一套单据链。
    const { syncShippingDocsToFinance } = await import('@/app/actions/shipping-docs-sync');
    await syncShippingDocsToFinance(orderId);
  } catch (e: any) {
    console.error('[confirm-shipped] shipment.completed 组装/发送异常(不阻断出货完成,outbox 兜底):', e?.message);
  }

  revalidatePath('/orders');
  return { ok: true, completed: payDone };
}

/**
 * 财务放货证据(2026-08-17):allow_shipment=true 本身不可信 —— 补建行天生开闸(存量 187 单)。
 * 真正放过货的两条路都留痕:①财务系统审批通过(shipment_confirmations.warehouse_signed)
 * ②站内放货/统一放货 Command(order_logs A2:business_override / critical_mutation:order_financials,注记含放货)。
 */
async function hasFinanceReleaseEvidence(svc: any, orderId: string): Promise<boolean> {
  const { exists: warehouseSigned } = await hasWarehouseSigned(svc, orderId);
  if (warehouseSigned) return true;
  const { exists: releaseLogged } = await hasFinanceReleaseLog(svc, orderId);
  return releaseLogged;
}
