'use server';

/**
 * 尺码表(2026-07-08 用户拍板):不在建单上传,改在订单「原辅料和包装(BOM)」页上传,喂生产任务单。
 * 存 order_attachments(file_type='size_chart')+ order-docs 私有桶;生产任务单直读该 file_type。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { createHash, randomUUID } from 'node:crypto';
import { parseSizeChartWorkbook } from '@/lib/parsers/size-chart';

const SIZE_CHART_TYPE = 'size_chart';   // 'use server' 只能 export async 函数,故不导出常量

/** 上传尺码表(FormData 传 file)。 */
export async function uploadSizeChart(orderId: string, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const file = formData.get('file') as File | null;
  if (!file || !file.size) return { error: '请选择文件' };
  if (file.size > 20 * 1024 * 1024) return { error: '文件不能超过 20MB' };
  if (!/\.xlsx$/i.test(file.name)) return { error: '尺码识别当前仅支持 XLSX；PDF/图片请保留附件并人工录入' };

  const bytes = await file.arrayBuffer();
  const checksum = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const { data: duplicate } = await (supabase.from('size_chart_imports') as any)
    .select('attachment_id').eq('order_id', orderId).eq('checksum_sha256', checksum).maybeSingle();
  if (duplicate) return { error: '重复文件：相同尺码表已上传，请使用现有记录' };

  let parsed: Awaited<ReturnType<typeof parseSizeChartWorkbook>> | null = null;
  let failureReason: string | null = null;
  try { parsed = await parseSizeChartWorkbook(bytes); }
  catch (error: any) { failureReason = String(error?.message || '无法识别尺码表布局').slice(0, 300); }

  // ⚠ Supabase Storage 的 key 只允许 ASCII;中文文件名(如「PY70EB尺寸表.xlsx」)会报 Invalid key。
  //   → key 用 UUID;原始文件名(含中文)仅存 order_attachments.file_name 供显示/下载。
  const ext = (String(file.name || '').match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '').toLowerCase();
  const path = `${orderId}/size-chart/${randomUUID()}${ext}`;
  const { error: upErr } = await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) return { error: `上传失败:${upErr.message}` };

  const { data: attachment, error: insErr } = await (supabase.from('order_attachments') as any).insert({
    order_id: orderId,
    file_name: file.name,
    file_type: SIZE_CHART_TYPE,
    storage_path: path,
    file_url: path,
    mime_type: file.type || null,
    uploaded_by: user.id,
  }).select('id').single();
  if (insErr) {
    await supabase.storage.from('order-docs').remove([path]).catch(() => {});
    return { error: insErr.message };
  }
  const { error: statusErr } = await (supabase.from('size_chart_imports') as any).insert({
    order_id: orderId,
    attachment_id: (attachment as any).id,
    checksum_sha256: checksum,
    parse_status: parsed ? 'NEEDS_REVIEW' : 'FAILED',
    parsed_json: parsed,
    failure_reason: failureReason,
    created_by: user.id,
  });
  if (statusErr) {
    await (supabase.from('order_attachments') as any).delete().eq('id', (attachment as any).id);
    await supabase.storage.from('order-docs').remove([path]).catch(() => {});
    return { error: /size_chart_imports|does not exist/i.test(statusErr.message || '')
      ? '尺码识别数据表尚未启用，请管理员执行待审批迁移'
      : `尺码解析状态保存失败:${statusErr.message}` };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 列出该订单的尺码表(含签名下载 URL)。 */
export async function listSizeCharts(orderId: string): Promise<{ data?: Array<{ id: string; file_name: string; url: string | null; parse_status: string; failure_reason: string | null; row_count: number }>; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('order_attachments') as any)
    .select('id, file_name, storage_path').eq('order_id', orderId).eq('file_type', SIZE_CHART_TYPE)
    .order('created_at', { ascending: false });
  if (error) return { error: error.message };
  const ids = (data || []).map((a: any) => a.id);
  const { data: imports } = ids.length ? await (supabase.from('size_chart_imports') as any)
    .select('attachment_id, parse_status, failure_reason, parsed_json').in('attachment_id', ids) : { data: [] };
  const byAttachment = new Map((imports || []).map((r: any) => [r.attachment_id, r]));
  const out: Array<{ id: string; file_name: string; url: string | null; parse_status: string; failure_reason: string | null; row_count: number }> = [];
  for (const a of (data || [])) {
    const { data: signed } = await supabase.storage.from('order-docs').createSignedUrl((a as any).storage_path, 3600);
    const status: any = byAttachment.get((a as any).id);
    out.push({ id: (a as any).id, file_name: (a as any).file_name, url: signed?.signedUrl ?? null,
      parse_status: status?.parse_status || 'UPLOADED', failure_reason: status?.failure_reason || null,
      row_count: Array.isArray(status?.parsed_json?.rows) ? status.parsed_json.rows.length : 0 });
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
