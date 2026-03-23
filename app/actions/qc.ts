'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getQcInspections(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('qc_inspections') as any)
    .select('*').eq('order_id', orderId).order('inspection_date', { ascending: false });
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addQcInspection(orderId: string, rec: {
  inspection_type: string; qty_inspected: number;
  qty_pass: number; qty_fail: number; aql_level?: string; notes?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!rec.qty_inspected || rec.qty_inspected <= 0) return { error: '抽检数量必须大于0' };

  const { error } = await (supabase.from('qc_inspections') as any).insert({
    order_id: orderId, inspector_id: user.id,
    inspection_type: rec.inspection_type || 'mid',
    qty_inspected: rec.qty_inspected,
    qty_pass: rec.qty_pass || 0,
    qty_fail: rec.qty_fail || 0,
    aql_level: rec.aql_level || 'II',
    notes: rec.notes || null,
    result: 'pending',
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function updateQcResult(id: string, orderId: string, result: 'pass' | 'fail' | 'conditional') {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('qc_inspections') as any)
    .update({ result, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteQcInspection(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('qc_inspections') as any).delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}
