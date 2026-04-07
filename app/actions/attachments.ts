'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/**
 * 附件管理 — 全部操作 order_attachments 表
 *
 * ⚠️ 历史 bug：本文件曾经写的是 `attachments` 表（实际不存在），
 * 导致 EvidenceUpload 的删除按钮按下后静默失败。
 * 2026-04-08 修复：统一对齐到 order_attachments + file_url + storage_path。
 */

export interface Attachment {
  id: string;
  milestone_id: string | null;
  order_id: string;
  url: string; // 兼容旧字段名 — 从 file_url 映射
  file_name: string | null;
  file_type: string | null;
  uploaded_by: string | null;
  created_at: string;
}

/** 把 DB 行映射到旧的 Attachment 接口（兼容现有 UI） */
function mapRow(r: any): Attachment {
  return {
    id: r.id,
    milestone_id: r.milestone_id,
    order_id: r.order_id,
    url: r.file_url,
    file_name: r.file_name,
    file_type: r.file_type,
    uploaded_by: r.uploaded_by,
    created_at: r.created_at,
  };
}

/**
 * 获取某个里程碑下的所有附件
 */
export async function getAttachmentsByMilestone(milestoneId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('order_attachments') as any)
    .select('id, milestone_id, order_id, file_url, file_name, file_type, uploaded_by, created_at, storage_path')
    .eq('milestone_id', milestoneId)
    .order('created_at', { ascending: false });

  if (error) return { error: error.message, data: null };
  return { data: (data || []).map(mapRow), error: null };
}

/**
 * 获取某个订单下的所有附件
 */
export async function getAttachmentsByOrder(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('order_attachments') as any)
    .select('id, milestone_id, order_id, file_url, file_name, file_type, uploaded_by, created_at, storage_path')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) return { error: error.message, data: null };
  return { data: (data || []).map(mapRow), error: null };
}

/**
 * 上传里程碑凭证文件
 */
export async function uploadEvidence(
  milestoneId: string,
  orderId: string,
  file: File,
): Promise<{ data: Attachment | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const fileExt = file.name.split('.').pop() || 'bin';
  const storagePath = `${orderId}/milestones/${milestoneId}_${Date.now()}.${fileExt}`;

  const { error: uploadError } = await supabase.storage
    .from('order-docs')
    .upload(storagePath, file, {
      contentType: file.type || undefined,
      upsert: false,
    });
  if (uploadError) return { data: null, error: `上传失败: ${uploadError.message}` };

  const { data: { publicUrl } } = supabase.storage
    .from('order-docs')
    .getPublicUrl(storagePath);

  const { data: row, error: insertError } = await (supabase.from('order_attachments') as any)
    .insert({
      milestone_id: milestoneId,
      order_id: orderId,
      file_url: publicUrl,
      storage_path: storagePath,
      file_name: file.name,
      file_type: 'evidence',
      file_size: file.size,
      mime_type: file.type || null,
      uploaded_by: user.id,
    })
    .select('id, milestone_id, order_id, file_url, file_name, file_type, uploaded_by, created_at')
    .single();

  if (insertError) {
    // 回滚 storage
    await supabase.storage.from('order-docs').remove([storagePath]);
    return { data: null, error: `写入失败: ${insertError.message}` };
  }

  revalidatePath(`/orders/${orderId}`);

  // 操作日志
  try {
    const { logEvidenceUpload } = await import('./milestones');
    await logEvidenceUpload(milestoneId, orderId, file.name);
  } catch {}

  return { data: mapRow(row), error: null };
}

/**
 * 删除附件 — 同时清理 Storage 和 DB
 *
 * 权限：上传者本人 / 订单创建者 / 管理员
 */
export async function deleteAttachment(attachmentId: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 取附件 + 订单创建者，做权限判断
  const { data: row, error: fetchError } = await (supabase.from('order_attachments') as any)
    .select('id, file_url, storage_path, uploaded_by, order_id')
    .eq('id', attachmentId)
    .single();
  if (fetchError || !row) return { error: '附件不存在或已被删除' };

  // 权限检查
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');

  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id')
    .eq('id', row.order_id)
    .single();

  const isUploader = row.uploaded_by === user.id;
  const isOrderOwner = order && (order.created_by === user.id || order.owner_user_id === user.id);

  if (!isAdmin && !isUploader && !isOrderOwner) {
    return { error: '无权删除：仅上传者本人、订单负责人或管理员可删除' };
  }

  // 删除 storage 文件（优先用 storage_path，回退到从 file_url 解析）
  let pathToRemove: string | null = row.storage_path || null;
  if (!pathToRemove && row.file_url) {
    try {
      const u = new URL(row.file_url);
      const idx = u.pathname.indexOf('/order-docs/');
      if (idx >= 0) pathToRemove = u.pathname.slice(idx + '/order-docs/'.length);
    } catch {}
  }
  if (pathToRemove) {
    await supabase.storage.from('order-docs').remove([pathToRemove]);
  }

  // 删除 DB 记录
  const { error: deleteError } = await (supabase.from('order_attachments') as any)
    .delete()
    .eq('id', attachmentId);
  if (deleteError) return { error: `删除失败: ${deleteError.message}` };

  revalidatePath(`/orders/${orderId}`);
  return { error: null };
}

/**
 * 检查里程碑是否已上传凭证
 */
export async function checkMilestoneEvidence(milestoneId: string) {
  const supabase = await createClient();

  const { data: milestone } = await (supabase.from('milestones') as any)
    .select('evidence_required')
    .eq('id', milestoneId)
    .single();
  if (!milestone) return { hasEvidence: false, required: false };
  if (!milestone.evidence_required) return { hasEvidence: true, required: false };

  const { data: rows } = await (supabase.from('order_attachments') as any)
    .select('id')
    .eq('milestone_id', milestoneId)
    .limit(1);

  return { hasEvidence: !!rows && rows.length > 0, required: true };
}
