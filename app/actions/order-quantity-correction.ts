'use server';

/**
 * 受控的「数量修正」通道(方案 C,2026-07-14)——以后数量读错/套装漏算,能就地改不用取消重建。
 * 与「客户加单」区分:加单=真的多要了(应收随之增);修正=原数量填错了(应收可保持不变,如套装按套报价)。
 *
 * 做的事(复用 applyCustomerAddOrder 的重算链):
 *  1) 按新总件数等比缩放逐款明细(sizes/qty_pcs)——整数倍(套装 ×2/×3)时精确,非整数尾差落最大行;
 *  2) 更新 orders.quantity;应收两种口径:
 *       keep  = 应收总额不变(套装按套报价:单价改成件价 = 原应收/新件数;行 po_unit_price 同步÷比例);
 *       scale = 应收随件数等比(真多/少了:单价不变,total_amount=新件数×单价);
 *  3) 重跑 MRP → 采购归并(补采购/refresh)+ 财务应收同步 + 生产/风险卡重算 + 通知四方;
 *  4) 开裁后软拦(需 force);全程审计走 runtime_events + 通知。
 *
 * 门禁:admin / 业务执行经理(order_manager)/ 开发业务经理(sales_manager)。改的是核心真相 + 钱,收敛到经理级。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { sumPhysicalPieceQty } from '@/lib/domain/line-item-quantity';

type RevenueMode = 'keep' | 'scale';

export async function correctOrderQuantity(input: {
  orderId: string;
  newTotalQty: number;
  revenueMode: RevenueMode;
  reason?: string;
  force?: boolean;
}): Promise<{ ok?: boolean; error?: string; needsConfirm?: boolean; warning?: string; summary?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');
  if (!isAdmin && !roles.some((r) => ['order_manager', 'sales_manager'].includes(r))) {
    return { error: '仅管理员 / 业务执行经理 / 开发业务经理可修正订单数量' };
  }

  const newTotal = Math.round(Number(input.newTotalQty) || 0);
  if (!(newTotal > 0)) return { error: '新总件数必须 > 0' };
  if (!['keep', 'scale'].includes(input.revenueMode)) return { error: '应收口径参数不对' };

  const svc = createServiceRoleClient();
  const { data: ord } = await (svc.from('orders') as any)
    .select('id, order_no, quantity, unit_price, total_amount').eq('id', input.orderId).maybeSingle();
  if (!(ord as any)?.id) return { error: '订单不存在' };

  const { data: lines } = await (svc.from('order_line_items') as any)
    .select('id, line_no, sizes, qty_pcs, qty_raw, set_multiplier, po_unit_price').eq('order_id', input.orderId).order('line_no', { ascending: true });
  const li = (lines || []) as any[];
  // 🐛 2026-08-12 修(数量语义):UI 明写「新总件数」且提示「1800 套×2 件 = 3600」→ 用户输入的是**物理件数**;
  //    此处原用 Σ qty_pcs(**商业套数**)当基数 → 套装单 ratio 直接翻倍:
  //    用户把 20400 件原样填一遍,就会把明细全部 ×2、订单静默变 40800,并连带重跑 MRP/采购/财务。
  //    基数必须与输入同口径 = 物理件数。缩放仍作用在 qty_pcs 上(倍率不变),故新物理数 == newTotal。
  const currentTotal = sumPhysicalPieceQty(li);
  if (currentTotal <= 0) return { error: '订单当前明细件数为 0,无法按比例修正(可能没建逐款明细)。请用取消重建。' };

  // ══ HEADER_RECONCILIATION(2026-08-12,1022982 暴露的结构性缺口)══
  // 状态:明细已按新 PO 更新(可信真相),但订单头/金额/财务还是旧值 —— 两条既有通道都走不通:
  //   · 普通改单:被「已有明细行」闸拦(那道闸防的是「头改了明细没改」,恰好相反的场景没覆盖)
  //   · 数量修正:拿明细当基数判等 → 报「与当前一致,无需修正」,而订单头其实还错着
  // 正确动作不是再缩放明细,而是**识别明细为可信真相,把订单头向它对齐**。
  // 铁律:ratio=1、绝不碰 line_items;金额按【商业数量 × 每套单价】(遵守数量语义,防套装从此入口回潮)。
  const headerQty = Number((ord as any).quantity);
  if (newTotal === currentTotal && Number.isFinite(headerQty) && headerQty !== newTotal) {
    return await reconcileHeaderToLineItems({
      svc, orderId: input.orderId, ord, li,
      physicalTotal: currentTotal, headerQty, reason: input.reason, actorId: user.id,
    });
  }
  if (newTotal === currentTotal) return { error: `新件数与当前(${currentTotal})一致,无需修正` };

  // 开裁后软拦(需 force):产前样确认/开裁已完成 → 生产可能已动,提醒二次确认
  if (!input.force) {
    const { REPORT_STEP_ALIASES } = await import('@/lib/production/stage');
    const kick = REPORT_STEP_ALIASES['production_kickoff'] || ['production_kickoff'];
    const { data: ms } = await (svc.from('milestones') as any)
      .select('status').eq('order_id', input.orderId).in('step_key', kick);
    const started = (ms || []).some((m: any) => ['done', '已完成', 'completed'].includes(String(m.status || '').toLowerCase()));
    if (started) {
      return { needsConfirm: true, warning: `该订单已开裁/投产,改数量会牵动在产采购与生产。确定要把总件数从 ${currentTotal} 改成 ${newTotal} 吗?` };
    }
  }

  const ratio = newTotal / currentTotal;

  // ── 1) 等比缩放逐款明细,尾差落到最大行的最大码,保证 Σ = newTotal ──
  const scaled = li.map((l) => {
    const oldSizes = l.sizes && typeof l.sizes === 'object' && !Array.isArray(l.sizes) ? l.sizes : null;
    let newSizes: Record<string, number> | null = null;
    let lineTotal: number;
    if (oldSizes) {
      newSizes = {};
      lineTotal = 0;
      for (const [k, v] of Object.entries(oldSizes)) {
        const nv = Math.max(0, Math.round((Number(v) || 0) * ratio));
        newSizes[k] = nv; lineTotal += nv;
      }
    } else {
      lineTotal = Math.max(0, Math.round((Number(l.qty_pcs) || 0) * ratio));
    }
    return { l, newSizes, lineTotal };
  });
  let sum = scaled.reduce((s, x) => s + x.lineTotal, 0);
  let diff = newTotal - sum;
  if (diff !== 0 && scaled.length > 0) {
    // 落到当前件数最大的行
    const big = scaled.reduce((a, b) => (b.lineTotal > a.lineTotal ? b : a), scaled[0]);
    big.lineTotal = Math.max(0, big.lineTotal + diff);
    if (big.newSizes) {
      // 落到该行最大码
      const keys = Object.keys(big.newSizes);
      if (keys.length > 0) {
        const bigKey = keys.reduce((a, b) => (big.newSizes![b] > big.newSizes![a] ? b : a), keys[0]);
        big.newSizes[bigKey] = Math.max(0, big.newSizes[bigKey] + diff);
      }
    }
  }

  // ── 2) 应收口径 ──
  const oldTotalAmount = Number((ord as any).total_amount);
  const oldUnitPrice = Number((ord as any).unit_price);
  const ordPatch: Record<string, any> = { quantity: newTotal };
  let priceDivisor = 1; // 行 po_unit_price 除数(keep 模式=ratio,保持行应收)
  if (input.revenueMode === 'keep') {
    const keptTotal = Number.isFinite(oldTotalAmount) && oldTotalAmount > 0
      ? oldTotalAmount
      : (Number.isFinite(oldUnitPrice) ? oldUnitPrice * currentTotal : NaN);
    if (Number.isFinite(keptTotal)) {
      ordPatch.total_amount = Math.round(keptTotal * 100) / 100;
      ordPatch.unit_price = Math.round((keptTotal / newTotal) * 10000) / 10000;
    }
    priceDivisor = ratio;
  } else {
    if (Number.isFinite(oldUnitPrice)) ordPatch.total_amount = Math.round(oldUnitPrice * newTotal * 100) / 100;
  }

  // ── 应用:明细 + 订单头 ──
  for (const x of scaled) {
    const patch: Record<string, any> = { qty_pcs: x.lineTotal, qty_raw: x.lineTotal };
    if (x.newSizes) patch.sizes = x.newSizes;
    if (input.revenueMode === 'keep' && x.l.po_unit_price != null && priceDivisor > 0) {
      patch.po_unit_price = Math.round((Number(x.l.po_unit_price) / priceDivisor) * 10000) / 10000;
    }
    const { error: uErr } = await (svc.from('order_line_items') as any).update(patch).eq('id', x.l.id);
    if (uErr) return { error: '更新明细失败:' + uErr.message };
  }
  const { error: oErr } = await (svc.from('orders') as any).update(ordPatch).eq('id', input.orderId);
  if (oErr) return { error: '更新订单数量失败:' + oErr.message };

  // ── 3) 重跑 MRP → 采购归并(补采购/refresh)+ 财务 + 生产/风险 + 通知(复用加单同款链)──
  try {
    const { submitBomToProcurement } = await import('./bom');
    await submitBomToProcurement(input.orderId);
    const { consolidateOrderProcurementItems } = await import('./procurement-items');
    // 增量→补采购(create);减量→只 refresh 现有需求,不新增、不自动砍已下采购单(人工处理)
    await consolidateOrderProcurementItems(input.orderId, { apply: { create: newTotal > currentTotal, refresh: true } });
  } catch (e: any) { console.warn('[correctOrderQuantity] 采购同步失败(不阻断):', e?.message); }
  try {
    const { data: fresh } = await (svc.from('orders') as any).select('*').eq('id', input.orderId).maybeSingle();
    if (fresh) {
      const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
      await syncOrderToFinance(fresh as Record<string, unknown>, 'order.updated');
    }
  } catch (e: any) { console.warn('[correctOrderQuantity] 财务同步失败(不阻断):', e?.message); }
  try {
    const { recomputeDeliveryConfidence } = await import('./runtime-confidence');
    await recomputeDeliveryConfidence(input.orderId, {
      type: 'amendment_applied', source: 'quantity_correction', severity: 'info',
      payload: { from: currentTotal, to: newTotal, revenueMode: input.revenueMode, reason: input.reason || null }, triggeredBy: user.id,
    });
  } catch (e: any) { console.warn('[correctOrderQuantity] recompute 失败(不阻断):', e?.message); }
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(svc, ['procurement', 'production', 'finance', 'merchandiser'], {
      type: 'amendment_approval',
      title: `✏️ 订单数量修正 ${currentTotal}→${newTotal} 件`,
      message: `订单 ${(ord as any).order_no} 数量修正为 ${newTotal} 件(应收${input.revenueMode === 'keep' ? '保持不变' : '随件数等比'})。采购需求/财务应收/生产数量已同步,请据新明细执行。${input.reason ? '原因:' + input.reason : ''}`,
      relatedOrderId: input.orderId,
    });
  } catch (e: any) { console.warn('[correctOrderQuantity] 通知失败(不阻断):', e?.message); }

  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true, summary: `已把总件数 ${currentTotal} → ${newTotal}(应收${input.revenueMode === 'keep' ? '保持不变' : '等比'}),并同步采购/财务/生产。` };
}

/**
 * HEADER_RECONCILIATION —— 订单头向明细对齐(2026-08-12)。
 *
 * 触发条件(调用方已判定):明细物理件数 == 请求数量 且 orders.quantity != 请求数量。
 * 语义:**明细是可信真相,订单头滞后**。这不是 Amendment(客户没再改),是 Data Reconciliation。
 *
 * 铁律:
 *  · 绝不修改任何 line_items(ratio 恒为 1)
 *  · 金额按【商业数量 × 每套单价】—— 不是 quantity × unit_price(套装单会翻倍,数量语义已钉死)
 *  · safeCriticalMutation:before 快照 + 写断言 + 写后回读验证 + A2 审计
 *  · 失败不产生部分成功:订单头写不成功就直接返回,不跑任何副作用
 */
async function reconcileHeaderToLineItems(args: {
  svc: any; orderId: string; ord: any; li: any[];
  physicalTotal: number; headerQty: number; reason?: string; actorId: string;
}): Promise<{ ok?: boolean; error?: string; summary?: string }> {
  const { svc, orderId, ord, li, physicalTotal, headerQty, reason, actorId } = args;
  const { sumCommercialQty } = await import('@/lib/domain/line-item-quantity');
  const { safeCriticalMutation } = await import('@/lib/db/safe-mutation');
  const { writeAuditEvent } = await import('@/lib/audit/write-audit-event');

  const commercialTotal = sumCommercialQty(li);
  const unitPrice = Number(ord.unit_price);
  const oldAmount = Number(ord.total_amount);
  // 金额 = 商业数量 × 每套单价(数量语义:unit_price 是 per commercial unit)
  const newAmount = Number.isFinite(unitPrice) && commercialTotal > 0
    ? Math.round(unitPrice * commercialTotal * 100) / 100
    : null;

  const patch: Record<string, any> = { quantity: physicalTotal };
  if (newAmount != null) patch.total_amount = newAmount;

  // ① 订单头:高危写(before 快照 + 行数断言 + 写后回读 + A2 审计)
  const w = await safeCriticalMutation({
    client: svc, table: 'orders', operation: 'update', expectedRows: 1,
    payload: patch, predicate: { id: orderId },
    ctx: {
      actor: actorId, riskLevel: 'money',
      reason: `订单头向明细对齐(HEADER_RECONCILIATION):数量 ${headerQty} → ${physicalTotal}`
        + `${newAmount != null ? `,金额 ${oldAmount} → ${newAmount}` : ''}${reason ? ` · ${reason}` : ''}`,
      verifyFields: patch,
      snapshotFields: ['quantity', 'total_amount'],
    },
    auditOrderId: orderId,
  });
  if (!w.ok) return { error: `订单头对齐失败(${w.status}):${w.error} —— 明细未被改动,可重试` };

  // ② 显式审计事件(独立于 critical_mutation:orders,便于按事件名反查这类自愈)
  await writeAuditEvent({
    eventType: 'quantity_header_reconciled_from_line_items', level: 'A2', riskLevel: 'money',
    actor: { actorType: 'user', actorId },
    entity: { entityType: 'order', entityId: orderId, orderId },
    commandName: 'reconcileHeaderToLineItems',
    reason: reason || '明细已按新 PO 更新,订单头滞后',
    beforeState: { quantity: headerQty, total_amount: Number.isFinite(oldAmount) ? oldAmount : null },
    afterState: { quantity: physicalTotal, total_amount: newAmount },
    metadata: { commercial_quantity: commercialTotal, physical_quantity: physicalTotal, unit_price: unitPrice, line_items_untouched: true },
  });

  // ③ 副作用:主写已验证才跑(顺序与 correctOrderQuantity 一致)
  try {
    const { submitBomToProcurement } = await import('./bom');
    await submitBomToProcurement(orderId);
    const { consolidateOrderProcurementItems } = await import('./procurement-items');
    // 头对齐不新增采购(数量并未真的增加),只 refresh 现有需求
    await consolidateOrderProcurementItems(orderId, { apply: { create: false, refresh: true } });
  } catch (e: any) { console.warn('[headerReconcile] 采购同步失败(不阻断):', e?.message); }
  try {
    const { data: fresh } = await (svc.from('orders') as any).select('*').eq('id', orderId).maybeSingle();
    if (fresh) {
      const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
      await syncOrderToFinance(fresh as Record<string, unknown>, 'order.updated');
    }
  } catch (e: any) { console.warn('[headerReconcile] 财务同步失败(不阻断):', e?.message); }
  try {
    const { recomputeDeliveryConfidence } = await import('./runtime-confidence');
    await recomputeDeliveryConfidence(orderId, {
      type: 'amendment_applied', source: 'header_reconciliation', severity: 'info',
      payload: { from: headerQty, to: physicalTotal, mode: 'header_reconciliation', reason: reason || null }, triggeredBy: actorId,
    });
  } catch (e: any) { console.warn('[headerReconcile] recompute 失败(不阻断):', e?.message); }
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(svc, ['procurement', 'production', 'finance', 'merchandiser'], {
      type: 'amendment_approval',
      title: `🔗 订单头对齐明细 ${headerQty}→${physicalTotal} 件`,
      message: `订单 ${ord.order_no} 的逐款明细此前已更新(合计 ${physicalTotal} 件 / ${commercialTotal} 套),`
        + `订单头数量与金额现已对齐(${headerQty}→${physicalTotal} 件`
        + `${newAmount != null ? `,金额 ${oldAmount}→${newAmount}` : ''})。明细未改动。${reason ? '原因:' + reason : ''}`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[headerReconcile] 通知失败(不阻断):', e?.message); }

  revalidatePath(`/orders/${orderId}`);
  return {
    ok: true,
    summary: `订单头已对齐明细:数量 ${headerQty} → ${physicalTotal} 件(${commercialTotal} 套)`
      + `${newAmount != null ? `,金额 ${oldAmount} → ${newAmount}` : ''};明细未改动。`,
  };
}
