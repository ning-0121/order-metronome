'use server';

/**
 * 纸箱规格 + 箱唛模板(#3)读写。存 orders.carton_spec jsonb。
 * 读:任何可见该订单的人;写:CAN_EDIT_MO(业务/跟单/生产/管理员,与生产任务单同权)。
 * 派生的每款×色纸箱/箱唛用 lib/domain/cartonSpec 纯函数算,出货可带进 packing_list_lines(后续接线)。
 */

import { createClient } from '@/lib/supabase/server';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';
import { revalidatePath } from 'next/cache';
import { deriveCartonRows, type CartonSpec } from '@/lib/domain/cartonSpec';

export async function getCartonSpec(orderId: string): Promise<{ data?: { spec: CartonSpec | null; derived: any[]; po: string; lines: any[] }; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('carton_spec, po_number, order_no, internal_order_no').eq('id', orderId).maybeSingle();
  const { data: lines } = await (supabase.from('order_line_items') as any)
    .select('style_no, color_cn, color_en, qty_pcs, carton_count').eq('order_id', orderId).order('line_no', { ascending: true });

  const spec: CartonSpec | null = (order as any)?.carton_spec || null;
  const po = (order as any)?.po_number || (order as any)?.internal_order_no || (order as any)?.order_no || '';
  const derived = spec ? deriveCartonRows(spec, (lines || []) as any[], { po }) : [];
  return { data: { spec, derived, po, lines: (lines || []) as any[] } };
}

export async function saveCartonSpec(orderId: string, spec: CartonSpec): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_MO', '仅业务/跟单/生产/管理员可编辑纸箱规格'); if (err) return { error: err }; }

  const { error } = await (supabase.from('orders') as any).update({ carton_spec: spec || null }).eq('id', orderId);
  if (error) {
    if (/carton_spec|column .* does not exist/i.test(error.message || '')) return { error: '纸箱规格列尚未建立:请先在 Supabase 执行 20260711_orders_carton_spec.sql' };
    return { error: error.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
