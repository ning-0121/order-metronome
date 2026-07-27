'use server';

/**
 * 打样费(2026-07-27 CEO):打样单记打样费金额 + 承担方,财务据此对客户收/免。
 * 读:登录+可访问订单;写:财务/业务/管理员(CAN_SEE_FINANCIALS)。只作用打样单。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { revalidatePath } from 'next/cache';

/** 客户承担的打样费才是应收(公司承担/待确认不进应收)。 */
const CUSTOMER_BORNE = new Set(['customer', 'fabric_customer']);

export const SAMPLE_FEE_BEARERS: Record<string, string> = {
  company: '公司承担', customer: '客户承担', fabric_customer: '面料客户+加工公司', tbd: '待确认',
};

async function ctx(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as const };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权访问此订单' as const };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  return { supabase, canEdit: hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS') };
}

export async function getSampleFee(orderId: string): Promise<{ amount?: number | null; bearer?: string | null; canEdit?: boolean; error?: string }> {
  const c = await ctx(orderId);
  if ('error' in c) return { error: c.error };
  const { data: o } = await (c.supabase.from('orders') as any).select('sample_fee, sample_fee_bearer, order_purpose').eq('id', orderId).maybeSingle();
  if (!o || (o as any).order_purpose !== 'sample') return { canEdit: false };   // 非打样单不显示
  return { amount: (o as any).sample_fee ?? null, bearer: (o as any).sample_fee_bearer ?? null, canEdit: c.canEdit };
}

export async function saveSampleFee(orderId: string, amount: number | null, bearer: string | null): Promise<{ ok?: boolean; error?: string }> {
  const c = await ctx(orderId);
  if ('error' in c) return { error: c.error };
  if (!c.canEdit) return { error: '仅财务/业务/管理员可录打样费' };
  let amt: number | null = null;
  if (amount !== null && amount !== undefined && String(amount).trim() !== '') {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return { error: '打样费须为 ≥0 的数字' };
    amt = Math.round(n * 100) / 100;
  }
  const b = bearer && SAMPLE_FEE_BEARERS[bearer] ? bearer : null;
  // 旧值(去重:仅应收变化时才发财务事件/通知,避免重复保存刷屏)
  const { data: old } = await (c.supabase.from('orders') as any).select('sample_fee, sample_fee_bearer, order_no, internal_order_no').eq('id', orderId).maybeSingle();
  const oldReceivable = CUSTOMER_BORNE.has(String((old as any)?.sample_fee_bearer || '')) ? Number((old as any)?.sample_fee) || 0 : 0;
  const newReceivable = (b && CUSTOMER_BORNE.has(b) && amt) ? amt : 0;

  const { error } = await (c.supabase.from('orders') as any).update({ sample_fee: amt, sample_fee_bearer: b }).eq('id', orderId);
  if (error) return { error: '保存失败:' + error.message };

  // 应收联动:客户承担的打样费 → 记订单财务事件(显示在财务事件时间线)+ 通知财务开票收款。仅金额变化时发。
  if (newReceivable > 0 && newReceivable !== oldReceivable) {
    try {
      const svc = createServiceRoleClient();
      const no = (old as any)?.internal_order_no || (old as any)?.order_no || orderId;
      await (svc.from('order_finance_events') as any).insert({
        order_id: orderId, order_no: no, event_type: 'sample_fee.receivable',
        amount: newReceivable, currency: 'CNY', note: `打样费应收(客户承担):¥${newReceivable}`, occurred_at: new Date().toISOString(),
      });
      const { notifyUsersByRole } = await import('@/lib/utils/notifications');
      await notifyUsersByRole(svc, ['finance'], {
        type: 'sample_fee_receivable', title: `💰 打样费应收 ¥${newReceivable}:${no}`,
        message: `打样单 ${no} 的打样费 ¥${newReceivable} 由客户承担,请开票并收款。`, relatedOrderId: orderId,
      });
    } catch (e) { console.warn('[sample-fee] 应收联动失败(不阻断):', e instanceof Error ? e.message : e); }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
