'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';
import { isDoneStatus, isApprovalPending } from '@/lib/domain/types';
import {
  AMENDMENT_RULES,
  checkAmendmentAllowed,
  type AmendmentSideEffect,
} from '@/lib/domain/amendment-policy';
import { recalcOrderMilestones } from './recalc-milestones';

/** 加载订单已完成的 step_key 集合（用于变更窗口判定） */
async function loadDoneStepKeys(supabase: any, orderId: string): Promise<Set<string>> {
  const { data } = await (supabase.from('milestones') as any)
    .select('step_key, status')
    .eq('order_id', orderId);
  const done = new Set<string>();
  for (const m of data || []) {
    if (isDoneStatus(m.status)) done.add(m.step_key);
  }
  return done;
}

/**
 * 提交订单修改申请
 */
export async function submitOrderAmendment(
  orderId: string,
  fields: Record<string, { from: string; to: string }>, // e.g. { quantity: { from: '1000', to: '1500' } }
  reason: string
): Promise<{ error?: string; success?: boolean; childOrderHint?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  if (!reason || reason.trim().length < 5) {
    return { error: '请填写修改原因（至少5个字）' };
  }

  if (Object.keys(fields).length === 0) {
    return { error: '请至少选择一项需要修改的内容' };
  }

  // 权限：仅订单创建者 / 跟单负责人 / 管理员可提交变更申请
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id, order_no, internal_order_no, customer_name')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  const isCreator = order.created_by === user.id;
  const isOwner = order.owner_user_id === user.id;
  if (!isAdmin && !isCreator && !isOwner) {
    return { error: '无权申请变更：仅订单创建者、跟单负责人或管理员可以操作' };
  }

  // ── 服务端窗口期校验 ──
  const doneStepKeys = await loadDoneStepKeys(supabase, orderId);
  let childOrderHint = false;
  for (const key of Object.keys(fields)) {
    const { allowed, rule, reason: blocked } = checkAmendmentAllowed(key, doneStepKeys);
    if (!allowed) {
      if (rule?.fallbackToChildOrder) childOrderHint = true;
      return {
        error: `「${rule?.label || key}」当前不允许变更：${blocked || '已超过窗口期'}`,
        childOrderHint,
      };
    }
  }

  const { error } = await (supabase.from('order_amendments') as any).insert({
    order_id: orderId,
    requested_by: user.id,
    fields_to_change: fields,
    reason: reason.trim(),
    status: 'pending', // pending → approved / rejected
  });

  if (error) {
    // 如果表不存在，给出友好提示
    if (error.message?.includes('does not exist') || error.code === '42P01') {
      return { error: '修改申请功能正在初始化，请联系管理员' };
    }
    return { error: '提交失败：' + error.message };
  }

  // 通知管理员:有订单变更申请待审批(审批权在 admin;否则申请石沉大海)(2026-07-04 用户反馈)
  try {
    const changed = Object.keys(fields).map((k) => AMENDMENT_RULES.find((r) => r.field === k)?.label || k).join('、');
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(supabase, ['admin'], {
      type: 'amendment_approval',
      title: `🟣 订单修改待审批：${(order as any).internal_order_no || (order as any).order_no || ''}`,
      message: `订单 ${(order as any).internal_order_no || (order as any).order_no || orderId}（${(order as any).customer_name || ''}）申请修改「${changed}」；原因：${reason.trim()}。请到该订单页审批。`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[submitOrderAmendment] 变更待审批通知失败(不阻断):', e?.message); }

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

export interface AddOrderRow {
  style_no?: string; product_name?: string;
  color_cn?: string; color_en?: string;
  sizes?: Record<string, number>; po_unit_price?: number | null;
}

/**
 * 客户加单(2026-07-11):业务录增量逐款明细(款/色/码×量),走改单审批闸;批准时追加进
 * order_line_items(独立新行·保批次痕迹),并同步采购(补采购)/财务(应收)/生产。
 * 不受 quantity_increase 窗口闸拦——加单就是采购下单后那条 fallback 通道。
 */
export async function submitCustomerAddOrder(
  orderId: string, rows: AddOrderRow[], reason: string,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!reason || reason.trim().length < 5) return { error: '请填写加单原因（至少5个字）' };

  // 清洗:每行 sizes 取正整数,至少有款号或颜色
  const clean = (Array.isArray(rows) ? rows : []).map((r) => {
    const sizes: Record<string, number> = {};
    let qty = 0;
    for (const [k, v] of Object.entries(r?.sizes || {})) {
      const n = Math.round(Number(v) || 0);
      if (String(k).trim() && n > 0) { sizes[String(k).trim()] = n; qty += n; }
    }
    return {
      style_no: String(r?.style_no ?? '').trim(), product_name: String(r?.product_name ?? '').trim(),
      color_cn: String(r?.color_cn ?? '').trim(), color_en: String(r?.color_en ?? '').trim(),
      sizes, qty,
      po_unit_price: r?.po_unit_price != null && Number(r.po_unit_price) >= 0 ? Number(r.po_unit_price) : null,
    };
  }).filter((r) => r.qty > 0 && (r.style_no || r.color_cn || r.color_en));
  if (clean.length === 0) return { error: '请至少录入一行有效加单明细(款/色 + 尺码数量>0)' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id, order_no, internal_order_no, customer_name').eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin && (order as any).created_by !== user.id && (order as any).owner_user_id !== user.id) {
    return { error: '无权加单:仅订单创建者/负责人/管理员' };
  }

  const totalAdd = clean.reduce((s, r) => s + r.qty, 0);
  const { error } = await (supabase.from('order_amendments') as any).insert({
    order_id: orderId, requested_by: user.id,
    fields_to_change: {},                 // 加单不改表头字段,明细在 line_items_delta
    line_items_delta: clean,
    reason: `【客户加单 +${totalAdd}件】${reason.trim()}`,
    status: 'pending',
  });
  if (error) {
    if (/line_items_delta|column .* does not exist/i.test(error.message || '')) {
      return { error: '加单列尚未建立:请先在 Supabase 执行 20260711_order_amendment_line_items_delta.sql' };
    }
    return { error: '提交失败:' + error.message };
  }
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(supabase, ['admin'], {
      type: 'amendment_approval',
      title: `🟣 客户加单待审批：${(order as any).internal_order_no || (order as any).order_no || ''}`,
      message: `订单 ${(order as any).internal_order_no || (order as any).order_no || orderId}（${(order as any).customer_name || ''}）客户加单 +${totalAdd}件（${clean.length}行）；原因：${reason.trim()}。请到该订单页审批。`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[submitCustomerAddOrder] 通知失败(不阻断):', e?.message); }
  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * 管理员审批修改申请
 */
export async function approveOrderAmendment(
  amendmentId: string,
  approved: boolean,
  adminNote?: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可审批' };

  const { data: { user } } = await supabase.auth.getUser();

  const { data: amendment, error: fetchErr } = await (supabase.from('order_amendments') as any)
    .select('*')
    .eq('id', amendmentId)
    .single();

  if (fetchErr || !amendment) return { error: '申请不存在' };
  if (!isApprovalPending(amendment.status)) return { error: '此申请已处理' };

  // 复审 P1(TOCTOU):窗口期只在提交时校验;审批常隔数天,此时订单可能已推进关键节点(如已开裁)。
  // 批准前用「当前」完成节点重校验每个待改字段,窗口已关则自动驳回,防已裁片后仍改小数量致静默错配。
  if (approved && amendment.fields_to_change) {
    const doneNow = await loadDoneStepKeys(supabase, amendment.order_id);
    const closed: string[] = [];
    for (const field of Object.keys(amendment.fields_to_change as Record<string, any>)) {
      if (!checkAmendmentAllowed(field, doneNow).allowed) closed.push(field);
    }
    if (closed.length > 0) {
      await (supabase.from('order_amendments') as any).update({
        status: 'rejected', reviewed_by: user!.id, reviewed_at: new Date().toISOString(),
        admin_note: (adminNote ? adminNote + '\n' : '') + `⛔ 提交后订单已推进关键节点,以下变更窗口已关闭,不能批准:${closed.join('、')}。请走专门流程(追加子订单/延期申请)。`,
      }).eq('id', amendmentId);
      revalidatePath(`/orders/${amendment.order_id}`);
      return { error: `变更窗口已关闭(${closed.join('、')})—— 提交后订单已推进关键节点,已自动驳回,请走专门流程。` };
    }
  }

  // 更新申请状态
  await (supabase.from('order_amendments') as any)
    .update({
      status: approved ? 'approved' : 'rejected',
      reviewed_by: user!.id,
      reviewed_at: new Date().toISOString(),
      admin_note: adminNote || null,
    })
    .eq('id', amendmentId);

  // 如果批准，自动应用修改到订单 + 触发副作用 + 收集提醒
  const reminders: string[] = [];
  if (approved && amendment.fields_to_change) {
    const fieldsObj = amendment.fields_to_change as Record<string, { to: string }>;
    const updates: Record<string, any> = {};
    const sideEffects = new Set<AmendmentSideEffect>();

    for (const [field, change] of Object.entries(fieldsObj)) {
      const rule = AMENDMENT_RULES.find(r => r.field === field);
      // quantity_increase / quantity_decrease 都要写到 quantity 字段
      const dbField =
        field === 'quantity_increase' || field === 'quantity_decrease' ? 'quantity' : field;
      updates[dbField] = change.to;

      if (rule) {
        for (const eff of rule.sideEffects) sideEffects.add(eff);
        if (rule.postApprovalReminder) reminders.push(rule.postApprovalReminder);
      }
    }

    if (Object.keys(updates).length > 0) {
      // 审计修(2026-07-04):改了 quantity/unit_price 要重算 total_amount,否则财务报表金额错。
      if ('quantity' in updates || 'unit_price' in updates) {
        const { data: curr } = await (supabase.from('orders') as any)
          .select('quantity, unit_price').eq('id', amendment.order_id).maybeSingle();
        const q = Number(updates.quantity ?? (curr as any)?.quantity);
        const up = Number(updates.unit_price ?? (curr as any)?.unit_price);
        if (Number.isFinite(q) && Number.isFinite(up)) updates.total_amount = Math.round(q * up * 100) / 100;
      }
      await (supabase.from('orders') as any)
        .update(updates)
        .eq('id', amendment.order_id);
    }

    // ── 副作用执行 ──
    await executeSideEffects(supabase, amendment.order_id, sideEffects, user!.id, reminders);

    // 审计修(2026-07-04):改单动了金额/数量/条款 → 重发 order.updated 给财务,否则财务应收停在改前值。
    try {
      const financeFields = ['quantity', 'unit_price', 'total_amount', 'currency', 'payment_terms'];
      if (Object.keys(updates).some((k) => financeFields.includes(k))) {
        const { data: fresh } = await (supabase.from('orders') as any).select('*').eq('id', amendment.order_id).maybeSingle();
        if (fresh) {
          const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
          await syncOrderToFinance(fresh as Record<string, unknown>, 'order.updated');
        }
      }
    } catch (e: any) { console.warn('[approveOrderAmendment] 改单财务同步失败(不阻断):', e?.message); }
  }

  // ── 客户加单:批准 → 追加增量明细 + 同步采购/财务/生产(line_items_delta 非空即加单)──
  if (approved && Array.isArray((amendment as any).line_items_delta) && (amendment as any).line_items_delta.length > 0) {
    const addRes = await applyCustomerAddOrder(supabase, amendment as any, user!.id);
    if (addRes.error) return { error: '加单应用失败：' + addRes.error };
    if (addRes.note) reminders.push('➕ ' + addRes.note);
  }

  // 把 reminders 持久化到 amendment 行（前端可读）
  if (reminders.length > 0) {
    await (supabase.from('order_amendments') as any)
      .update({ admin_note: (adminNote ? adminNote + '\n\n' : '') + reminders.join('\n\n') })
      .eq('id', amendmentId);
  }

  revalidatePath(`/orders/${amendment.order_id}`);
  return { success: true };
}

/**
 * 客户加单应用:追加增量行到 order_line_items(独立新行·source=add_order)+ bump orders.quantity
 * + 重跑 MRP/采购归并(补采购)+ 财务应收 + 生产重算/通知。批准时调。
 */
async function applyCustomerAddOrder(
  supabase: any, amendment: any, actorUserId: string,
): Promise<{ error?: string; note?: string }> {
  const orderId = amendment.order_id;
  const delta: any[] = Array.isArray(amendment.line_items_delta) ? amendment.line_items_delta : [];
  if (delta.length === 0) return { note: '无加单明细' };

  // 追加起始 line_no = 现有 MAX + 1(独立新行,不复用/不合并)
  const { data: maxRow } = await (supabase.from('order_line_items') as any)
    .select('line_no').eq('order_id', orderId).order('line_no', { ascending: false }).limit(1).maybeSingle();
  let lineNo = Number((maxRow as any)?.line_no) || 0;

  const batchTag = `客户加单 ${new Date().toISOString().slice(0, 10)}`;
  const rows: any[] = [];
  let addQty = 0;
  for (const r of delta) {
    const sizes: Record<string, number> = {};
    let qty = 0;
    for (const [k, v] of Object.entries(r?.sizes || {})) {
      const n = Math.round(Number(v) || 0);
      if (String(k).trim() && n > 0) { sizes[String(k).trim()] = n; qty += n; }
    }
    if (qty <= 0) continue;
    lineNo++; addQty += qty;
    rows.push({
      order_id: orderId, line_no: lineNo,
      style_no: r.style_no || null, product_name: r.product_name || null,
      color_cn: r.color_cn || null, color_en: r.color_en || null,
      sizes, unit: 'pcs', set_multiplier: 1,
      qty_pcs: qty, qty_raw: qty,
      po_unit_price: r.po_unit_price != null ? Number(r.po_unit_price) : null,
      source: 'add_order',
      remark: batchTag,
      created_by: actorUserId,
    });
  }
  if (rows.length === 0) return { note: '无有效加单行' };

  // 追加(insert-only,绝不删旧行)——新列缺失降级
  let { error: insErr } = await (supabase.from('order_line_items') as any).insert(rows);
  if (insErr && /po_unit_price|created_by|remark|column .* does not exist/i.test(insErr.message || '')) {
    const plain = rows.map(({ po_unit_price, created_by, remark, ...rest }: any) => rest);
    ({ error: insErr } = await (supabase.from('order_line_items') as any).insert(plain));
  }
  if (insErr) return { error: '追加明细失败：' + insErr.message };

  // orders.quantity += Σ;total_amount 重算(=新数量×现单价,与现有改单口径一致)
  const { data: ord } = await (supabase.from('orders') as any)
    .select('quantity, unit_price').eq('id', orderId).maybeSingle();
  const newQty = (Number((ord as any)?.quantity) || 0) + addQty;
  const up = Number((ord as any)?.unit_price);
  const patch: any = { quantity: newQty };
  if (Number.isFinite(newQty) && Number.isFinite(up)) patch.total_amount = Math.round(newQty * up * 100) / 100;
  await (supabase.from('orders') as any).update(patch).eq('id', orderId);

  // 采购:重跑 MRP(需求按款×色求和)→ 归并(采购已下单则新增量自动挂补采购)
  try {
    const { submitBomToProcurement } = await import('./bom');
    await submitBomToProcurement(orderId);
    const { consolidateOrderProcurementItems } = await import('./procurement-items');
    await consolidateOrderProcurementItems(orderId, { apply: { create: true, refresh: true } });
  } catch (e: any) { console.warn('[applyCustomerAddOrder] 采购同步失败(不阻断):', e?.message); }

  // 财务:应收按新总额更新
  try {
    const { data: fresh } = await (supabase.from('orders') as any).select('*').eq('id', orderId).maybeSingle();
    if (fresh) {
      const { syncOrderToFinance } = await import('@/lib/integration/finance-sync');
      await syncOrderToFinance(fresh as Record<string, unknown>, 'order.updated');
    }
  } catch (e: any) { console.warn('[applyCustomerAddOrder] 财务同步失败(不阻断):', e?.message); }

  // 生产/风险卡 + 通知采购/生产/财务/跟单
  try {
    const { recomputeDeliveryConfidence } = await import('./runtime-confidence');
    await recomputeDeliveryConfidence(orderId, {
      type: 'amendment_applied', source: 'customer_add_order', severity: 'info',
      payload: { added_qty: addQty, rows: rows.length }, triggeredBy: actorUserId,
    });
  } catch (e: any) { console.warn('[applyCustomerAddOrder] recompute 失败(不阻断):', e?.message); }
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications');
    await notifyUsersByRole(supabase, ['procurement', 'production', 'finance', 'merchandiser'], {
      type: 'amendment_approval',
      title: `➕ 客户加单已生效 +${addQty}件`,
      message: `订单已客户加单 +${addQty}件（${rows.length}行）。采购需求/财务应收/生产数量已同步,请据新明细执行。`,
      relatedOrderId: orderId,
    });
  } catch (e: any) { console.warn('[applyCustomerAddOrder] 通知失败(不阻断):', e?.message); }

  return { note: `已追加 +${addQty}件（${rows.length}行）并同步采购/财务/生产` };
}

/**
 * 执行变更副作用：重算节拍器、重置节点、通知相关角色
 */
async function executeSideEffects(
  supabase: any,
  orderId: string,
  effects: Set<AmendmentSideEffect>,
  actorUserId: string,
  reminders: string[],
) {
  // 1. 重算节拍器（改交期 / 改贸易条款）
  if (effects.has('recalc_schedule')) {
    try { await recalcOrderMilestones(orderId); } catch {}
    // ── Runtime Hook 3: anchor 变更（出厂日 / ETD / 仓库截止）→ 异步重算 confidence
    void (async () => {
      try {
        const { recomputeDeliveryConfidence } = await import('./runtime-confidence');
        await recomputeDeliveryConfidence(orderId, {
          type: 'anchor_changed',
          source: `amendment:recalc_schedule`,
          severity: 'info',
          payload: { effects: Array.from(effects) },
          triggeredBy: actorUserId,
        });
      } catch (e: any) {
        console.error('[runtime-hook]', 'anchor_changed hook crashed:', e?.message);
      }
    })();
  }

  // 2. 重置「包装方式确认」节点 → in_progress + 清空 evidence
  if (effects.has('reset_packing_method_milestone')) {
    await (supabase.from('milestones') as any)
      .update({
        status: 'in_progress',
        completed_at: null,
        completed_by: null,
        notes: '⚠️ 因包装方式变更被重置 — 需重新上传包装资料',
      })
      .eq('order_id', orderId)
      .eq('step_key', 'packing_method_confirmed');
    // 复审:此重置未走 recalc_schedule 分支时不会触发 recompute → 投影滞后。补一次(fire-and-forget)。
    if (!effects.has('recalc_schedule')) {
      void (async () => {
        try {
          const { recomputeDeliveryConfidence } = await import('./runtime-confidence');
          await recomputeDeliveryConfidence(orderId, { type: 'milestone_status_changed', source: 'amendment:reset_packing', severity: 'info', payload: { step_key: 'packing_method_confirmed' }, triggeredBy: actorUserId });
        } catch (e: any) { console.warn('[amendment] 包装重置 recompute 失败(不阻断):', e?.message); }
      })();
    }
  }

  // 2.5 采购需求联动(审计#2):改数量/款/色等采购相关变更 → 把采购项+未收货执行行标「需重新确认」。
  //     不自动重算 BOM 单耗(避免误改),而是让采购/跟单据变更重新核料;标记后采购 UI 会提示 needs_reconfirm。
  if (effects.has('notify_procurement')) {
    try {
      await (supabase.from('procurement_items') as any)
        .update({ needs_reconfirm: true }).eq('order_id', orderId)
        .not('status', 'in', '("closed","completed")');
    } catch (e: any) { console.warn('[amendment] 采购项标需重确认失败(列缺/不阻断):', e?.message); }
    try {
      await (supabase.from('procurement_line_items') as any)
        .update({ needs_reconfirm: true }).eq('order_id', orderId)
        .not('line_status', 'in', '("received","accepted","closed","concession","cancelled")');
    } catch (e: any) { console.warn('[amendment] 执行行标需重确认失败(列缺/不阻断):', e?.message); }
  }

  // 3. 通知相关角色(采购变更时一并通知生产,别只发采购铃铛)
  const notifyRoles: Array<{ effect: AmendmentSideEffect; role: string; label: string }> = [
    { effect: 'notify_procurement', role: 'procurement', label: '采购' },
    { effect: 'notify_procurement', role: 'production', label: '生产' },
    { effect: 'notify_finance', role: 'finance', label: '财务' },
    { effect: 'notify_merchandiser', role: 'merchandiser', label: '跟单' },
    { effect: 'notify_production_manager', role: 'production_manager', label: '生产主管' },
  ];

  // 取订单号供通知使用
  const { data: orderRow } = await (supabase.from('orders') as any)
    .select('order_no, customer_name')
    .eq('id', orderId)
    .single();
  const orderTag = orderRow ? `${orderRow.order_no}（${orderRow.customer_name}）` : orderId;

  for (const { effect, role, label } of notifyRoles) {
    if (!effects.has(effect)) continue;
    // 找到所有该角色用户
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, role, roles');
    const targets = (profiles || []).filter((p: any) => {
      const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
      return rs.includes(role);
    });
    for (const t of targets) {
      await (supabase.from('notifications') as any).insert({
        user_id: t.user_id,
        type: 'order_amendment',
        title: `订单变更通知（${label}）`,
        message: `订单 ${orderTag} 已批准变更，请关注后续工作${reminders.length > 0 ? '：\n' + reminders.join('\n') : ''}`,
        related_order_id: orderId,
      });
    }
  }
}

/**
 * 获取订单的修改申请列表
 */
export async function getOrderAmendments(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('order_amendments') as any)
    .select('*, requester:profiles!order_amendments_requested_by_fkey(name, email), reviewer:profiles!order_amendments_reviewed_by_fkey(name)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) {
    // Table might not exist yet
    return { data: [], error: null };
  }
  return { data: data || [], error: null };
}

