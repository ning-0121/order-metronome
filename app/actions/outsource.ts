'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getOutsourceJobs(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('outsource_jobs') as any)
    .select('*').eq('order_id', orderId).order('created_at', { ascending: false });
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addOutsourceJob(orderId: string, job: {
  factory_name: string; job_type: string; qty_sent: number;
  expected_return_date?: string; factory_contact?: string; unit_price?: number;
  expected_workers?: number; expected_start_date?: string; expected_end_date?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!job.factory_name?.trim()) return { error: '工厂名称不能为空' };
  if (!job.qty_sent || job.qty_sent <= 0) return { error: '发出数量必须大于0' };

  const { error } = await (supabase.from('outsource_jobs') as any).insert({
    order_id: orderId, created_by: user.id,
    factory_name: job.factory_name.trim(),
    job_type: job.job_type || 'other',
    qty_sent: job.qty_sent,
    expected_return_date: job.expected_return_date || null,
    expected_workers: job.expected_workers || null,
    expected_start_date: job.expected_start_date || null,
    expected_end_date: job.expected_end_date || null,
    factory_contact: job.factory_contact || null,
    unit_price: job.unit_price || null,
    status: 'pending',
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function updateOutsourceJob(id: string, orderId: string, patch: {
  qty_returned?: number; qty_pass?: number; qty_defect?: number;
  status?: string; notes?: string; actual_return_date?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('outsource_jobs') as any)
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteOutsourceJob(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('outsource_jobs') as any).delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}
