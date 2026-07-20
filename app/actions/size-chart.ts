'use server';

/**
 * 尺码表(2026-07-08 用户拍板):不在建单上传,改在订单「原辅料和包装(BOM)」页上传,喂生产任务单。
 * 存 order_attachments(file_type='size_chart')+ order-docs 私有桶;生产任务单直读该 file_type。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { createHash, randomUUID } from 'node:crypto';
import { parseSizeChartWorkbook, type SizeChartParseOptions } from '@/lib/parsers/size-chart';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const SIZE_CHART_TYPE = 'size_chart';   // 'use server' 只能 export async 函数,故不导出常量
const SIZE_CHART_PARSER_VERSION = 'size-chart-v2-2026-07-18';

function parseFailureMessage(parsed: Awaited<ReturnType<typeof parseSizeChartWorkbook>>): string | null {
  return parsed.errors[0] || parsed.diagnostics[0]?.message || parsed.warnings[0] || null;
}

async function persistParsedResult(
  supabase: Awaited<ReturnType<typeof createClient>>,
  attachmentId: string,
  orderId: string,
  parsed: Awaited<ReturnType<typeof parseSizeChartWorkbook>>,
  userId: string,
) {
  const { data, error } = await (supabase.from('size_chart_imports') as any).update({
    worksheet_name: parsed.worksheetName,
    parse_status: parsed.status,
    parsed_row_count: parsed.rows.length,
    parsed_json: parsed,
    parser_version: parsed.parserVersion,
    error_code: parsed.status === 'FAILED' ? 'UNSUPPORTED_LAYOUT' : null,
    safe_error_message: parsed.status === 'FAILED' ? parseFailureMessage(parsed) : null,
    updated_by: userId,
  }).eq('attachment_id', attachmentId).eq('order_id', orderId).select('id').single();
  if (error) return error;
  if (!data?.id) return new Error('解析结果更新未命中目标记录');
  return null;
}

/** 上传尺码表(FormData 传 file)。 */
export async function uploadSizeChart(orderId: string, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', '仅生产/跟单/QC/主管可上传·复核尺码表'); if (err) return { error: err }; }
  const file = formData.get('file') as File | null;
  if (!file || !file.size) return { error: '请选择文件' };
  if (file.size > 20 * 1024 * 1024) return { error: '文件不能超过 20MB' };
  if (!/\.xlsx$/i.test(file.name)) return { error: '尺码识别当前仅支持 XLSX；PDF/图片请保留附件并人工录入' };

  const bytes = await file.arrayBuffer();
  const checksum = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const { data: duplicate } = await (supabase.from('size_chart_imports') as any)
    .select('attachment_id').eq('order_id', orderId).eq('document_type', SIZE_CHART_TYPE)
    .eq('checksum_sha256', checksum).limit(1).maybeSingle();
  if (duplicate) return { error: '重复文件：相同尺码表已上传，请使用现有记录' };

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
    document_type: SIZE_CHART_TYPE,
    source_filename: file.name,
    checksum_sha256: checksum,
    parser_version: SIZE_CHART_PARSER_VERSION,
    worksheet_name: null, parse_status: 'UPLOADED', parsed_row_count: 0, parsed_json: null,
    error_code: null, safe_error_message: null,
    created_by: user.id,
  });
  if (statusErr) {
    await (supabase.from('order_attachments') as any).delete().eq('id', (attachment as any).id);
    await supabase.storage.from('order-docs').remove([path]).catch(() => {});
    return { error: /size_chart_imports|does not exist/i.test(statusErr.message || '')
      ? '尺码识别数据表尚未启用，请管理员执行待审批迁移'
      : `尺码解析状态保存失败:${statusErr.message}` };
  }
  await (supabase.from('size_chart_imports') as any).update({ parse_status: 'PARSING', updated_by: user.id }).eq('attachment_id', (attachment as any).id);
  try {
    const parsed = await parseSizeChartWorkbook(bytes);
    const parseSaveErr = await persistParsedResult(supabase, (attachment as any).id, orderId, parsed, user.id);
    if (parseSaveErr) return { error: `解析结果保存失败:${parseSaveErr.message}` };
  } catch (error: any) {
    const safe = String(error?.message || '无法识别尺码表布局').slice(0, 300);
    await (supabase.from('size_chart_imports') as any).update({ parse_status: 'FAILED', error_code: 'UNSUPPORTED_LAYOUT',
      safe_error_message: safe, updated_by: user.id }).eq('attachment_id', (attachment as any).id);
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

export async function reparseSizeChart(
  attachmentId: string,
  orderId: string,
  options: SizeChartParseOptions = {},
): Promise<{ ok?: boolean; data?: any; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', '仅生产/跟单/QC/主管可上传·复核尺码表'); if (err) return { error: err }; }
  // User session proves that this logged-in employee can see the order. The exact attachment read/write then
  // uses service-role because Storage and size_chart_imports RLS previously made reparses silently retain FAILED.
  const { data: visibleOrder } = await (supabase.from('orders') as any).select('id').eq('id', orderId).maybeSingle();
  if (!visibleOrder) return { error: '无权读取该订单' };
  const svc = createServiceRoleClient();
  const { data: attachment, error: attachmentErr } = await (svc.from('order_attachments') as any)
    .select('id, file_name, storage_path, file_type, order_id')
    .eq('id', attachmentId)
    .eq('order_id', orderId)
    .eq('file_type', SIZE_CHART_TYPE)
    .single();
  if (attachmentErr || !attachment) return { error: '未找到尺码表附件' };
  const { data: file, error: downloadErr } = await svc.storage.from('order-docs').download((attachment as any).storage_path);
  if (downloadErr || !file) return { error: `读取尺码表失败:${downloadErr?.message || '文件不可读取'}` };
  const bytes = await file.arrayBuffer();
  try {
    const { data: target, error: targetErr } = await (svc.from('size_chart_imports') as any)
      .select('id').eq('attachment_id', attachmentId).eq('order_id', orderId).single();
    if (targetErr || !target) return { error: '当前附件没有对应的尺码解析记录' };
    await (svc.from('size_chart_imports') as any).update({ parse_status: 'PARSING', updated_by: user.id }).eq('id', (target as any).id);
    const parsed = await parseSizeChartWorkbook(bytes, options);
    const parseSaveErr = await persistParsedResult(svc as any, attachmentId, orderId, parsed, user.id);
    if (parseSaveErr) return { error: `重新解析结果保存失败:${parseSaveErr.message}`, data: { attachmentId, updatedRecordId: (target as any).id, updatedRowCount: 0, parserStatus: 'FAILED' } };
    const { data: persisted, error: verifyErr } = await (svc.from('size_chart_imports') as any)
      .select('id,attachment_id,order_id,parser_version,parse_status,worksheet_name,parsed_row_count,parsed_json,error_code,safe_error_message,updated_at')
      .eq('id', (target as any).id).single();
    if (verifyErr || !persisted || (persisted as any).parse_status !== parsed.status || Number((persisted as any).parsed_row_count) !== parsed.rows.length) {
      return { error: '重新解析已执行，但持久化回读不一致，请联系管理员', data: { attachmentId, updatedRecordId: (target as any).id, updatedRowCount: 0, parserStatus: (persisted as any)?.parse_status || parsed.status } };
    }
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, data: { ...persisted, attachmentId, storagePath: String((attachment as any).storage_path || '').replace(/([^/]{6})[^/]*(\.xlsx)$/i, '$1…$2'), updatedRecordId: (target as any).id, updatedRowCount: parsed.rows.length, parserStatus: parsed.status, worksheet: parsed.worksheetName, sizeCount: parsed.sizeLabels.length, measurementCount: parsed.measurementLabels.length, error: null } };
  } catch (error: any) {
    const safe = String(error?.message || '无法识别尺码表布局').slice(0, 300);
    await (svc.from('size_chart_imports') as any).update({ parse_status: 'FAILED', error_code: 'UNSUPPORTED_LAYOUT', safe_error_message: safe, updated_by: user.id }).eq('attachment_id', attachmentId).eq('order_id', orderId);
    return { error: safe, data: { attachmentId, updatedRecordId: null, updatedRowCount: 0, parserStatus: 'FAILED', error: safe } };
  }
}

/** 列出该订单的尺码表(含签名下载 URL)。 */
export async function listSizeCharts(orderId: string): Promise<{ data?: Array<{ id: string; file_name: string; url: string | null; parse_status: string; failure_reason: string | null; row_count: number; orientation: string | null; confidence: number | null; worksheet_name: string | null; size_count: number; measurement_count: number }>; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: visibleOrder } = await (supabase.from('orders') as any).select('id').eq('id', orderId).maybeSingle();
  if (!visibleOrder) return { error: '无权读取该订单' };
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_attachments') as any)
    .select('id, file_name, storage_path').eq('order_id', orderId).eq('file_type', SIZE_CHART_TYPE)
    .order('created_at', { ascending: false });
  if (error) return { error: error.message };
  const ids = (data || []).map((a: any) => a.id);
  const { data: imports } = ids.length ? await (svc.from('size_chart_imports') as any)
    .select('id, attachment_id, parse_status, safe_error_message, parsed_row_count, parsed_json, worksheet_name')
    .in('attachment_id', ids) : { data: [] };
  const byAttachment = new Map((imports || []).map((r: any) => [r.attachment_id, r]));
  const out: Array<{ id: string; file_name: string; url: string | null; parse_status: string; failure_reason: string | null; row_count: number; orientation: string | null; confidence: number | null; worksheet_name: string | null; size_count: number; measurement_count: number }> = [];
  for (const a of (data || [])) {
    const { data: signed } = await svc.storage.from('order-docs').createSignedUrl((a as any).storage_path, 3600);
    const status: any = byAttachment.get((a as any).id);
    const parsed = status?.parsed_json || {};
    out.push({
      id: (a as any).id,
      file_name: (a as any).file_name,
      url: signed?.signedUrl ?? null,
      parse_status: status?.parse_status || 'UPLOADED',
      failure_reason: status?.safe_error_message || status?.parsed_json?.warnings?.[0] || null,
      row_count: Number(status?.parsed_row_count) || 0,
      orientation: parsed?.orientation || null,
      confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
      worksheet_name: status?.worksheet_name || parsed?.worksheetName || null,
      size_count: Array.isArray(parsed?.sizeLabels) ? parsed.sizeLabels.length : 0,
      measurement_count: Array.isArray(parsed?.measurementLabels) ? parsed.measurementLabels.length : 0,
      parser_record_id: status?.id || null,
      storage_path_hint: String((a as any).storage_path || '').replace(/([^/]{6})[^/]*(\.xlsx)$/i, '$1…$2'),
    });
  }
  return { data: out };
}

export async function getSizeChartImport(attachmentId: string, orderId: string) {
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { error: '请先登录' };
  const { data: visibleOrder } = await (supabase.from('orders') as any).select('id').eq('id', orderId).maybeSingle();
  if (!visibleOrder) return { error: '无权读取该订单' };
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('size_chart_imports') as any)
    .select('id,parse_status,worksheet_name,parsed_row_count,parsed_json,error_code,safe_error_message,reviewed_at,created_at,updated_at')
    .eq('attachment_id', attachmentId).eq('order_id', orderId).single();
  return error ? { error: error.message } : { data };
}

export async function reviewSizeChart(attachmentId: string, orderId: string, decision: 'approve' | 'reject') {
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { error: '请先登录' };
  const { data: current } = await (supabase.from('size_chart_imports') as any).select('parse_status').eq('attachment_id', attachmentId).eq('order_id', orderId).single();
  if (!current || !['NEEDS_REVIEW','PARSED'].includes(current.parse_status)) return { error: '仅待复核的尺码表可以审核' };
  const update = decision === 'approve'
    ? { parse_status: 'APPROVED', reviewed_by: user.id, updated_by: user.id, reviewed_at: new Date().toISOString() }
    : { parse_status: 'FAILED', error_code: 'REJECTED_BY_REVIEWER', safe_error_message: '人工复核未通过', reviewed_by: user.id, updated_by: user.id, reviewed_at: new Date().toISOString() };
  const { error } = await (supabase.from('size_chart_imports') as any).update(update).eq('attachment_id', attachmentId).eq('order_id', orderId);
  revalidatePath(`/orders/${orderId}`); return error ? { error: error.message } : { ok: true };
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
