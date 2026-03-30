'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getBomItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('materials_bom') as any)
    .select('*').eq('order_id', orderId).order('material_type');
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addBomItem(orderId: string, item: {
  material_name: string; material_type: string;
  material_code?: string; qty_per_piece?: number; total_qty?: number;
  unit?: string; supplier?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!item.material_name?.trim()) return { error: '物料名称不能为空' };

  const { error } = await (supabase.from('materials_bom') as any).insert({
    order_id: orderId, created_by: user.id,
    material_name: item.material_name.trim(),
    material_type: item.material_type || 'other',
    material_code: item.material_code || null,
    qty_per_piece: item.qty_per_piece || null,
    total_qty: item.total_qty || null,
    unit: item.unit || 'meter',
    supplier: item.supplier || null,
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function updateBomItem(id: string, orderId: string, patch: Record<string, any>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('materials_bom') as any)
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteBomItem(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('materials_bom') as any).delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}
