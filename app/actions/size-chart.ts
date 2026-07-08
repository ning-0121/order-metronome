'use server';

/**
 * 尺码表(2026-07-08 用户拍板):不在建单上传,改在订单「原辅料和包装(BOM)」页上传,喂生产任务单。
 * 存 order_attachments(file_type='size_chart')+ order-docs 私有桶;生产任务单直读该 file_type。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const SIZE_CHART_TYPE = 'size_chart';   // 'use server' 只能 export async 函数,故不导出常量

/** 上传尺码表(FormData 传 file)。 */
export async function uploadSizeChart(orderId: string, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const file = formData.get('file') as File | null;
  if (!file || !file.size) return { error: '请选择文件' };
  if (file.size > 20 * 1024 * 1024) return { error: '文件不能超过 20MB' };

  const safeName = String(file.name || 'file').replace(/[^\w.\-一-龥]/g, '_');
  const path = `${orderId}/size-chart/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) return { error: `上传失败:${upErr.message}` };

  const { error: insErr } = await (supabase.from('order_attachments') as any).insert({
    order_id: orderId,
    file_name: file.name || safeName,
    file_type: SIZE_CHART_TYPE,
    storage_path: path,
    file_url: path,
    mime_type: file.type || null,
    uploaded_by: user.id,
  });
  if (insErr) {
    await supabase.storage.from('order-docs').remove([path]).catch(() => {});
    return { error: insErr.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 列出该订单的尺码表(含签名下载 URL)。 */
export async function listSizeCharts(orderId: string): Promise<{ data?: Array<{ id: string; file_name: string; url: string | null }>; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('order_attachments') as any)
    .select('id, file_name, storage_path').eq('order_id', orderId).eq('file_type', SIZE_CHART_TYPE)
    .order('created_at', { ascending: false });
  if (error) return { error: error.message };
  const out: Array<{ id: string; file_name: string; url: string | null }> = [];
  for (const a of (data || [])) {
    const { data: signed } = await supabase.storage.from('order-docs').createSignedUrl((a as any).storage_path, 3600);
    out.push({ id: (a as any).id, file_name: (a as any).file_name, url: signed?.signedUrl ?? null });
  }
  return { data: out };
}

/** 删除一张尺码表。 */
export async function deleteSizeChart(id: string, orderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: att } = await (supabase.from('order_attachments') as any).select('storage_path').eq('id', id).eq('file_type', SIZE_CHART_TYPE).maybeSingle();
  const { error } = await (supabase.from('order_attachments') as any).delete().eq('id', id).eq('file_type', SIZE_CHART_TYPE);
  if (error) return { error: error.message };
  if ((att as any)?.storage_path) await supabase.storage.from('order-docs').remove([(att as any).storage_path]).catch(() => {});
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
