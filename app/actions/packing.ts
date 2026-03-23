'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getPackingLists(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('packing_lists') as any)
    .select('*, packing_list_lines(*)').eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addPackingList(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const plNumber = `PL-${Date.now().toString(36).toUpperCase()}`;
  const { data, error } = await (supabase.from('packing_lists') as any)
    .insert({ order_id: orderId, created_by: user.id, pl_number: plNumber, status: 'draft' })
    .select('id').single();
  if (error) return { data: null, error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { data, error: null };
}

export async function addPackingLine(packingListId: string, orderId: string, line: {
  style_no?: string; color?: string; carton_count: number;
  qty_per_carton: number;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const totalQty = (line.carton_count || 0) * (line.qty_per_carton || 0);
  const { error } = await (supabase.from('packing_list_lines') as any).insert({
    packing_list_id: packingListId, order_id: orderId,
    style_no: line.style_no || null, color: line.color || null,
    carton_count: line.carton_count, qty_per_carton: line.qty_per_carton,
    total_qty: totalQty,
  });
  if (error) return { error: error.message };

  // 更新装箱单合计
  const { data: lines } = await (supabase.from('packing_list_lines') as any)
    .select('carton_count, total_qty').eq('packing_list_id', packingListId);
  const totalCartons = (lines || []).reduce((s: number, l: any) => s + (l.carton_count || 0), 0);
  const totalPcs = (lines || []).reduce((s: number, l: any) => s + (l.total_qty || 0), 0);
  await (supabase.from('packing_lists') as any)
    .update({ total_cartons: totalCartons, total_qty: totalPcs }).eq('id', packingListId);

  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deletePackingLine(lineId: string, packingListId: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('packing_list_lines') as any).delete().eq('id', lineId);
  if (error) return { error: error.message };

  // 更新合计
  const { data: lines } = await (supabase.from('packing_list_lines') as any)
    .select('carton_count, total_qty').eq('packing_list_id', packingListId);
  const totalCartons = (lines || []).reduce((s: number, l: any) => s + (l.carton_count || 0), 0);
  const totalPcs = (lines || []).reduce((s: number, l: any) => s + (l.total_qty || 0), 0);
  await (supabase.from('packing_lists') as any)
    .update({ total_cartons: totalCartons, total_qty: totalPcs }).eq('id', packingListId);

  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function confirmPackingList(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('packing_lists') as any)
    .update({ status: 'confirmed', confirmed_by: user.id, confirmed_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'draft');
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}
