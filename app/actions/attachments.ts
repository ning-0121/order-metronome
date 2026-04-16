'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

/**
 * 附件管理 — 操作 order_attachments 表
 *
 * 历史：
 * - 2026-04-08：修复表名从 `attachments` 对齐到 order_attachments
 * - 2026-04-15：移除 uploadEvidence/getAttachmentsByMilestone/getAttachmentsByOrder，
 *   统一由 components/MilestoneActions.tsx 直接写入（含命名校验和按节点映射 file_type）
 */

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
 * 获取附件的临时签名下载 URL（1 小时有效）
 *
 * P1 修复（2026-04-07）：
 * 之前所有附件用 getPublicUrl() 永久公开，泄露风险高。
 * 现在用 createSignedUrl 按需签发。
 *
 * 权限：上传者本人 / 订单创建者 / 跟单负责人 / 管理员
 *
 * 用法（前端）：
 *   const { url, error } = await getAttachmentDownloadUrl(attachment.id);
 *   if (url) window.open(url);
 *
 * 注意：要让此功能完全生效，Storage bucket "order-docs" 需要在 Supabase Dashboard
 * 设置为 private（取消 Public 勾选）。在 bucket 还是 public 时，老的 file_url
 * 仍然能直接访问 — 这一步是渐进式收紧。
 */
export async function getAttachmentDownloadUrl(
  attachmentId: string,
): Promise<{ url?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: row, error: fetchErr } = await (supabase.from('order_attachments') as any)
    .select('id, storage_path, file_url, uploaded_by, order_id')
    .eq('id', attachmentId)
    .single();
  if (fetchErr || !row) return { error: '附件不存在' };

  // 权限校验
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
    return { error: '无权下载该附件' };
  }

  // 优先用 storage_path 签发 signed URL
  let pathToSign: string | null = row.storage_path || null;
  // 兼容老数据：从 file_url 反解 path
  if (!pathToSign && row.file_url) {
    try {
      const u = new URL(row.file_url);
      const idx = u.pathname.indexOf('/order-docs/');
      if (idx >= 0) pathToSign = u.pathname.slice(idx + '/order-docs/'.length);
    } catch {}
  }

  if (!pathToSign) {
    // 兜底：返回老的 public URL
    return { url: row.file_url || undefined };
  }

  const { data: signedData, error: signErr } = await supabase.storage
    .from('order-docs')
    .createSignedUrl(pathToSign, 3600);

  if (signErr || !signedData?.signedUrl) {
    // 签发失败时回退到 public URL（保证可用性）
    console.error('[getAttachmentDownloadUrl] signed url failed:', signErr?.message);
    return { url: row.file_url || undefined };
  }

  return { url: signedData.signedUrl };
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
