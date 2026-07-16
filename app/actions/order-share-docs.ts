'use server';

/**
 * 订单共享文件(2026-07-11 用户拍板):取消 AI「原辅料单识别」后,业务在「原辅料和包装」页对整个 PO
 * 上传两类文件,共享给采购部 / 生产部 / 财务部:
 *   - accessory_purchase_list  辅料采购清单
 *   - packing_method           包装方式
 *
 * 存 order_attachments(file_type 用上面两个值)。文件走**公开桶 product-images**(与排版稿同一
 * 可见通道),存永久公开 URL —— 采购核料页 / 生产任务单页 / 采购单附页 都按此 URL 直接给下载,
 * 私有桶签名 URL 1 小时过期不适合跨部门/发外。file_type 白名单校验,防写入任意类型。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const SHARE_TYPES = ['accessory_purchase_list', 'packing_method'];   // 'use server' 只能 export async,故不导出常量
const BUCKET = 'product-images';                                     // 公开桶(排版稿同款,跨部门/供应商可直接开)

function okType(t: string): boolean { return SHARE_TYPES.includes(t); }

/** 上传订单共享文件(FormData 传 file;fileType ∈ 白名单)。 */
export async function uploadOrderShareDoc(orderId: string, fileType: string, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  if (!okType(fileType)) return { error: '非法文件类型' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const file = formData.get('file') as File | null;
  if (!file || !file.size) return { error: '请选择文件' };
  if (file.size > 20 * 1024 * 1024) return { error: '文件不能超过 20MB' };

  // Storage key 只允许 ASCII;中文文件名会报 Invalid key → key 用 ASCII 安全名 + 随机后缀,
  // 原始文件名(含中文)存 order_attachments.file_name 供显示/下载。
  const ext = (String(file.name || '').match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] || '').toLowerCase();
  const base = String(file.name || 'file').replace(/\.[^.]*$/, '').replace(/[^\w.\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'file';
  const rand = Math.random().toString(36).slice(2, 7);
  const path = `order-share/${orderId}/${fileType}/${Date.now()}-${rand}-${base}${ext}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) return { error: `上传失败:${upErr.message}` };
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

  const { data: attachment, error: insErr } = await (supabase.from('order_attachments') as any).insert({
    order_id: orderId,
    file_name: file.name || `${base}${ext}`,
    file_type: fileType,
    storage_path: path,
    file_url: pub?.publicUrl || '',       // 永久公开 URL(跨部门/供应商可开)
    mime_type: file.type || null,
    uploaded_by: user.id,
  }).select('id').single();
  if (insErr) {
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    return { error: insErr.message };
  }
  let imported = 0; let warning: string | undefined;
  if (fileType === 'accessory_purchase_list' && /\.xlsx$/i.test(file.name)) {
    const { importAccessoryCandidates } = await import('@/app/actions/accessory-import');
    const parsed = await importAccessoryCandidates(orderId, (attachment as any).id, await file.arrayBuffer());
    if ((parsed as any).error) warning = `文件已上传，但候选行解析失败：${(parsed as any).error}`;
    else imported = Number((parsed as any).count) || 0;
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, imported, warning } as any;
}

/** 列出该订单某类共享文件(公开 URL,直接可开)。 */
export async function listOrderShareDocs(orderId: string, fileType: string): Promise<{ data?: Array<{ id: string; file_name: string; url: string | null }>; error?: string }> {
  if (!okType(fileType)) return { error: '非法文件类型' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('order_attachments') as any)
    .select('id, file_name, file_url').eq('order_id', orderId).eq('file_type', fileType)
    .order('created_at', { ascending: false });
  if (error) return { error: error.message };
  return { data: (data || []).map((a: any) => ({ id: a.id, file_name: a.file_name, url: a.file_url || null })) };
}

/** 删除一份共享文件。 */
export async function deleteOrderShareDoc(id: string, orderId: string, fileType: string): Promise<{ ok?: boolean; error?: string }> {
  if (!okType(fileType)) return { error: '非法文件类型' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: att } = await (supabase.from('order_attachments') as any).select('storage_path').eq('id', id).eq('file_type', fileType).maybeSingle();
  if (fileType === 'accessory_purchase_list') {
    const { error: candidateErr } = await (supabase.from('accessory_import_candidates') as any).delete().eq('source_attachment_id', id).eq('order_id', orderId);
    if (candidateErr) return { error: `候选审核记录清理失败:${candidateErr.message}` };
  }
  const { error } = await (supabase.from('order_attachments') as any).delete().eq('id', id).eq('file_type', fileType);
  if (error) return { error: error.message };
  if ((att as any)?.storage_path) await supabase.storage.from(BUCKET).remove([(att as any).storage_path]).catch(() => {});
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
