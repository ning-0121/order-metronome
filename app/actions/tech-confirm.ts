'use server';

/**
 * 技术部大货确认单(2026-07-06 用户拍板):业务在大货单耗表旁上传技术部签名确认单;
 * 不传不许提交采购(必传闸)。存 order_attachments(file_type='tech_bulk_confirm')+ order-docs 桶。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const TECH_CONFIRM_TYPE = 'tech_bulk_confirm';   // 'use server' 文件只能 export async 函数,故不导出

/** 上传技术确认单(FormData 传 file)。 */
export async function uploadTechConfirm(orderId: string, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const file = formData.get('file') as File | null;
  if (!file || !file.size) return { error: '请选择文件' };
  if (file.size > 20 * 1024 * 1024) return { error: '文件不能超过 20MB' };

  const safeName = String(file.name || 'file').replace(/[^\w.\-一-龥]/g, '_');
  const path = `${orderId}/tech-confirm/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (upErr) return { error: `上传失败:${upErr.message}` };

  const { error: insErr } = await (supabase.from('order_attachments') as any).insert({
    order_id: orderId,
    file_name: file.name || safeName,
    file_type: TECH_CONFIRM_TYPE,
    storage_path: path,
    file_url: path,            // 展示兜底;真下载走 getAttachmentDownloadUrl(storage_path 签名)
    mime_type: file.type || null,
    uploaded_by: user.id,
  });
  if (insErr) {
    // 插库失败 → 清掉已传的存储文件,避免孤儿
    await supabase.storage.from('order-docs').remove([path]).catch(() => {});
    return { error: insErr.message };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 是否已传技术确认单(提交采购必传闸用)。 */
export async function hasTechConfirm(orderId: string): Promise<boolean> {
  const supabase = await createClient();
  const { count } = await (supabase.from('order_attachments') as any)
    .select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('file_type', TECH_CONFIRM_TYPE);
  return (count || 0) > 0;
}
