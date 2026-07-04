'use server';

/**
 * 补采购(2026-07-03)—— 两条入口,一个财务闸:
 *  ① 品类补:业务执行在订单「原辅料」加行 → 核料归并出新项;若订单已过「采购下单」
 *    节点,consolidate 会自动标补采购(见 procurement-items.ts)。
 *  ② 数量补(本文件):生产中不够料 → 业务执行对已有采购项提「补数量」,生成一条
 *    新采购项(同物料身份、数量=补量、独立 consolidation_key 便于单独跟踪/核销)。
 *  闸:补采购项 finance_approval_status='pending' → 通知财务;财务批准后采购才能
 *    确认→生成执行行→归采购单。采购部不自造需求。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';

/** 可提交补料申请的角色(业务执行 + 管理员;生产发现缺料也由业务执行代提,保持单一入口) */
const REQUEST_ROLES = ['sales', 'sales_manager', 'order_manager', 'admin'];
const FINANCE_ROLES = ['finance', 'admin'];

async function userRoles(supabase: any): Promise<{ userId?: string; roles: string[]; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { roles: [], error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { userId: user.id, roles };
}

/** 通知全体财务:有补采购待审批(进系统通知铃铛;财务系统 webhook 预警在采购单下达时一并带 flag)。 */
export async function notifyFinanceSupplement(supabase: any, orderId: string, itemName: string, qty: number | null, unit: string | null, reason: string) {
  try {
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no, customer_name').eq('id', orderId).maybeSingle();
    const { data: financeUsers } = await (supabase.from('profiles') as any)
      .select('user_id, role, roles');
    const targets = (financeUsers || []).filter((p: any) => {
      const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
      return rs.includes('finance');
    });
    if (targets.length === 0) return;
    await (supabase.from('notifications') as any).insert(targets.map((t: any) => ({
      user_id: t.user_id,
      type: 'supplement_approval',
      title: `🟠 补采购待审批:${order?.order_no || ''}`,
      message: `订单 ${order?.order_no || orderId}(${order?.customer_name || ''})补采购「${itemName}」${qty != null ? ` ${qty}${unit || ''}` : ''};原因:${reason}。请到订单「采购核料」审批。`,
      related_order_id: orderId,
    })));
  } catch { /* 通知失败不阻塞主流程 */ }
}

/**
 * 数量补:对已有采购项申请补量 → 生成新采购项(补采购,待财务审批)。
 * 是数量不够,不是新品类 → 物料身份完全继承原项,数量=补量。
 */
export async function requestSupplementQty(
  orderId: string, baseItemId: string, qty: number, reason: string,
): Promise<{ ok?: boolean; itemNo?: string; error?: string }> {
  const supabase = await createClient();
  const auth = await userRoles(supabase);
  if (!auth.userId) return { error: auth.error };
  if (!auth.roles.some(r => REQUEST_ROLES.includes(r))) {
    return { error: '仅业务执行/管理员可提交补料申请(生产缺料请报业务执行提交)' };
  }
  if (!qty || qty <= 0) return { error: '补量必须大于 0' };
  if (!reason?.trim()) return { error: '请填写补采购原因(生产损耗超标/裁剪不够/其他)——财务审批要看' };

  const { data: base, error: bErr } = await (supabase.from('procurement_items') as any)
    .select('id, order_id, consolidation_key, material_master_id, material_name, specification, category, color, unit, purchase_unit, development_consumption')
    .eq('id', baseItemId).single();
  if (bErr || !base) return { error: bErr?.message || '找不到原采购项' };
  if ((base as any).order_id !== orderId) return { error: '采购项与订单不匹配' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no').eq('id', orderId).single();
  const { count } = await (supabase.from('procurement_items') as any)
    .select('id', { count: 'exact', head: true }).eq('order_id', orderId);

  const now = new Date().toISOString();
  const itemNo = `PI-${(order as any)?.order_no || 'ORD'}-S${String((count || 0) + 1).padStart(2, '0')}`;
  // 独立 consolidation_key:补采购单独跟踪/单独核销,不与原项混(五层脊柱口径不变)
  const suppKey = `${(base as any).consolidation_key}|supp:${crypto.randomUUID().slice(0, 8)}`;

  const { error: iErr } = await (supabase.from('procurement_items') as any).insert({
    order_id: orderId,
    consolidation_key: suppKey,
    item_no: itemNo,
    material_master_id: (base as any).material_master_id,
    material_name: (base as any).material_name,
    specification: (base as any).specification,
    category: (base as any).category,
    color: (base as any).color,
    unit: (base as any).unit,
    purchase_unit: (base as any).purchase_unit,
    development_consumption: (base as any).development_consumption,
    total_required_qty: qty,
    source_count: 1,
    suggested_purchase_qty: qty,
    status: 'draft',
    is_supplement: true,
    supplement_reason: reason.trim(),
    supplement_base_item_id: baseItemId,
    supplement_requested_by: auth.userId,
    supplement_requested_at: now,
    finance_approval_status: 'pending',
    created_by: auth.userId,
  });
  if (iErr) {
    if (/is_supplement|finance_approval_status|column .* does not exist/i.test(iErr.message || '')) {
      return { error: '补采购字段尚未建立:请先在 Supabase 执行 20260703_procurement_supplement.sql' };
    }
    return { error: friendlyError(iErr) };
  }

  await notifyFinanceSupplement(supabase, orderId, (base as any).material_name || '物料', qty, (base as any).unit, reason.trim());
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, itemNo };
}

/** 超报价基线财务审批(P2b):批准后该采购项方可确认/下单。仅财务/管理员。 */
export async function approveBaselineOver(
  itemId: string, approve: boolean, rejectReason?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const auth = await userRoles(supabase);
  if (!auth.userId) return { error: auth.error };
  if (!auth.roles.some((r) => FINANCE_ROLES.includes(r))) return { error: '仅财务/管理员可审批超报价基线' };
  if (!approve && !rejectReason?.trim()) return { error: '驳回请填写原因' };

  const { data: item, error: gErr } = await (supabase.from('procurement_items') as any)
    .select('id, order_id, baseline_over_status').eq('id', itemId).single();
  if (gErr || !item) return { error: gErr?.message || '找不到该采购项' };
  if (!(item as any).baseline_over_status) return { error: '该项未触发超基线审批' };
  if ((item as any).baseline_over_status === 'approved' && approve) return { ok: true };

  const now = new Date().toISOString();
  const { error } = await (supabase.from('procurement_items') as any).update({
    baseline_over_status: approve ? 'approved' : 'rejected',
    baseline_over_approved_by: auth.userId,
    baseline_over_approved_at: now,
    baseline_over_reject_reason: approve ? null : rejectReason!.trim(),
    updated_at: now,
  }).eq('id', itemId);
  if (error) return { error: friendlyError(error) };

  revalidatePath(`/orders/${(item as any).order_id}`);
  return { ok: true };
}

/** 财务审批补采购:批准 → 采购可正常确认/执行;驳回 → 项保留但永久不可执行(留痕)。 */
export async function approveSupplement(
  itemId: string, approve: boolean, rejectReason?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const auth = await userRoles(supabase);
  if (!auth.userId) return { error: auth.error };
  if (!auth.roles.some(r => FINANCE_ROLES.includes(r))) return { error: '仅财务/管理员可审批补采购' };
  if (!approve && !rejectReason?.trim()) return { error: '驳回请填写原因' };

  const { data: item, error: gErr } = await (supabase.from('procurement_items') as any)
    .select('id, order_id, material_name, is_supplement, finance_approval_status').eq('id', itemId).single();
  if (gErr || !item) return { error: gErr?.message || '找不到该采购项' };
  if (!(item as any).is_supplement) return { error: '该项不是补采购,无需审批' };
  if ((item as any).finance_approval_status === 'approved' && approve) return { ok: true };

  const now = new Date().toISOString();
  const { error } = await (supabase.from('procurement_items') as any).update({
    finance_approval_status: approve ? 'approved' : 'rejected',
    finance_approved_by: auth.userId,
    finance_approved_at: now,
    finance_reject_reason: approve ? null : rejectReason!.trim(),
    updated_at: now,
  }).eq('id', itemId);
  if (error) return { error: friendlyError(error) };

  revalidatePath(`/orders/${(item as any).order_id}`);
  return { ok: true };
}
