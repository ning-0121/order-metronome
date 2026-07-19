'use server';

/**
 * Customer PO — 绑定层（Phase D）
 *
 * PO = "Quote 冻结快照的绑定记录"，不是复制/继承/重算 Quote。
 *
 * 铁律（本文件强制）：
 *   - 消费 Quote MUST 只经 getApprovedQuoteForCompare（消费闸门）
 *   - MUST NOT 读 quoter_quotes(live) / quote_line
 *   - MUST NOT 重算报价 / 不碰 RAG / 成本引擎
 *   - createPO 只写 customer_po 的 5 个绑定字段
 *   - getPOView 只读 customer_po + quote_version_snapshot（冻结快照）
 */

import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { getApprovedQuoteForCompare } from '@/app/actions/quote-consumption';
import { evaluatePoCreation, type CreatePOInput, type POView, type CustomerPoRow } from '@/lib/po/types';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { deriveCustomerPoVersions, type CustomerPoAttachmentRow, type CustomerPoAuditLogRow } from '@/lib/domain/customer-po-version';
import { extractPOFromAttachment } from '@/app/actions/po-extract';

const CUSTOMER_PO_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);

function getExt(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function safeCustomerPoObjectKey(orderId: string, originalName: string, uuid = randomUUID()): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(orderId)) throw new Error('INVALID_ORDER_ID');
  if (originalName.includes('/') || originalName.includes('\\') || originalName.includes('\0')) {
    throw new Error('INVALID_FILE_NAME');
  }
  const ext = getExt(originalName);
  if (!CUSTOMER_PO_EXTENSIONS.has(ext)) throw new Error('UNSUPPORTED_FILE_TYPE');
  const finalExt = ext === 'jpeg' ? 'jpg' : ext;
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error('INVALID_UUID');
  return `${orderId}/customer-po/${uuid}.${finalExt}`;
}

async function canManageCustomerPo(supabase: any, orderId: string, userId: string): Promise<boolean> {
  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return false;
  const { isAdmin, roles } = await getCurrentUserRole(supabase);
  const roleList: string[] = roles || [];
  return isAdmin
    || order.created_by === userId
    || order.owner_user_id === userId
    || roleList.some((r) => ['sales_manager', 'order_manager', 'admin'].includes(r));
}

async function loadCustomerPoHistory(orderId: string) {
  const supabase = await createClient();
  const { data: attachments } = await (supabase.from('order_attachments') as any)
    .select('id, order_id, file_type, file_name, storage_path, file_url, uploaded_by, created_at')
    .eq('order_id', orderId)
    .eq('file_type', 'customer_po')
    .order('created_at', { ascending: true });
  const { data: logs } = await (supabase.from('order_logs') as any)
    .select('action, note, payload, created_at, actor_user_id')
    .eq('order_id', orderId)
    .in('action', ['customer_po_replaced', 'customer_po_withdrawn'])
    .order('created_at', { ascending: true });
  const history = deriveCustomerPoVersions((attachments || []) as CustomerPoAttachmentRow[], (logs || []) as CustomerPoAuditLogRow[]);
  return history;
}

/**
 * 创建 Customer PO —— 只能绑定 approved 冻结快照。
 */
export async function createPO(input: CreatePOInput): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const quoteId = input.quoteId;
  const customerId = input.customerId;
  const poNumber = input.poNumber?.trim();
  if (!poNumber) return { error: 'PO 号必填' };
  if (!customerId) return { error: '客户必填' };
  if (!quoteId) return { error: '报价必填' };

  // STEP 1 — 消费闸门（唯一入口；内部只读冻结快照 + 审批信封）
  const basis = await getApprovedQuoteForCompare(quoteId);

  // STEP 2/3 — 硬门控：consumable + 客户一致（纯逻辑判定）
  const decision = evaluatePoCreation(basis, customerId);
  if (!decision.ok) return { error: decision.error };

  // STEP 4 — 唯一写：只存绑定字段（无价/成本/毛利/行）
  const { data, error } = await (supabase.from('customer_po') as any)
    .insert({
      po_number: poNumber,
      customer_id: customerId,
      quote_id: quoteId,
      quote_snapshot_version: decision.snapshotVersion,
      status: 'draft',
    })
    .select('id')
    .single();

  if (error) return { error: '创建 PO 失败：' + error.message };
  return { id: (data as any).id };
}

/**
 * 读取 PO 完整视图 —— 只用冻结快照，绝不读 live quote。
 */
export async function getPOView(poId: string): Promise<{ view?: POView; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // load PO
  const { data: po } = await (supabase.from('customer_po') as any)
    .select('*').eq('id', poId).maybeSingle();
  if (!po) return { error: 'PO 不存在' };

  // load snapshot（ONLY frozen；version 绑定）—— 不读 quoter_quotes / quote_line
  const { data: snap } = await (supabase.from('quote_version_snapshot') as any)
    .select('snapshot')
    .eq('quote_id', (po as any).quote_id)
    .eq('version', (po as any).quote_snapshot_version)
    .maybeSingle();

  const quote_snapshot = (snap as any)?.snapshot ?? null;

  return {
    view: {
      po: po as CustomerPoRow,
      quote_snapshot,
      comparison_ready: quote_snapshot != null,
    },
  };
}

export async function getCustomerPoHistory(orderId: string): Promise<{
  versions?: Array<ReturnType<typeof deriveCustomerPoVersions>['versions'][number] & { uploaded_by_name?: string | null }>;
  activeVersion?: (ReturnType<typeof deriveCustomerPoVersions>['activeVersion'] & { uploaded_by_name?: string | null }) | null;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const allowed = await canManageCustomerPo(supabase, orderId, user.id);
  if (!allowed) return { error: '无权查看客户 PO 历史' };
  const history = await loadCustomerPoHistory(orderId);
  const uploaderIds = [...new Set(history.versions.map((row) => row.uploaded_by).filter(Boolean))] as string[];
  let uploaderMap = new Map<string, string | null>();
  if (uploaderIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, full_name, name, email')
      .in('user_id', uploaderIds);
    uploaderMap = new Map((profiles || []).map((p: any) => [p.user_id, p.full_name || p.name || p.email || null]));
  }
  const versions = history.versions.map((row) => ({
    ...row,
    uploaded_by_name: row.uploaded_by ? uploaderMap.get(row.uploaded_by) || null : null,
  }));
  const activeVersion = history.activeVersion
    ? { ...history.activeVersion, uploaded_by_name: history.activeVersion.uploaded_by ? uploaderMap.get(history.activeVersion.uploaded_by) || null : null }
    : null;
  return { versions, activeVersion };
}

export async function replaceCustomerPo(
  orderId: string,
  formData: FormData,
): Promise<{ ok?: boolean; error?: string; warning?: string; activeVersionId?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const allowed = await canManageCustomerPo(supabase, orderId, user.id);
  if (!allowed) return { error: '无权更换客户 PO' };

  const file = formData.get('file') as File | null;
  const reason = String(formData.get('reason') || '').trim();
  if (!file || !file.size) return { error: '请选择新版 PO 文件' };
  if (reason.length < 3) return { error: '请填写更换原因' };

  const ext = getExt(file.name || '');
  if (!CUSTOMER_PO_EXTENSIONS.has(ext)) return { error: '仅支持 PDF、JPG、PNG、WEBP' };

  const historyBefore = await loadCustomerPoHistory(orderId);
  const previousActive = historyBefore.activeVersion;
  const objectKey = safeCustomerPoObjectKey(orderId, file.name || `customer-po.${ext}`);
  const { error: uploadErr } = await supabase.storage.from('order-docs').upload(objectKey, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (uploadErr) return { error: `上传失败：${uploadErr.message}` };

  const { data: attachment, error: insertErr } = await (supabase.from('order_attachments') as any).insert({
    order_id: orderId,
    file_type: 'customer_po',
    file_name: file.name || `customer-po.${ext}`,
    storage_path: objectKey,
    file_url: objectKey,
    file_size: file.size,
    mime_type: file.type || null,
    uploaded_by: user.id,
  }).select('id').single();
  if (insertErr) {
    await supabase.storage.from('order-docs').remove([objectKey]).catch(() => {});
    return { error: `保存失败：${insertErr.message}` };
  }

  await (supabase.from('order_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'customer_po_replaced',
    note: reason,
    payload: JSON.stringify({
      kind: 'customer_po_replaced',
      from_attachment_id: previousActive?.id || null,
      to_attachment_id: attachment.id,
      old_file_name: previousActive?.file_name || null,
      new_file_name: file.name || null,
      reason,
    }),
    created_at: new Date().toISOString(),
  });

  let warning: string | undefined;
  try {
    const sourceType = ext === 'pdf' ? 'pdf' : 'image_po';
    const extractRes = await extractPOFromAttachment(String(attachment.id), orderId, sourceType);
    if (extractRes.error) warning = `新版 PO 已保存，但解析需人工确认：${extractRes.error}`;
  } catch (e: any) {
    warning = `新版 PO 已保存，但解析需人工确认：${e?.message || String(e)}`;
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, warning, activeVersionId: String(attachment.id) };
}

export async function withdrawCustomerPoVersion(
  orderId: string,
  attachmentId: string,
  reason: string,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const allowed = await canManageCustomerPo(supabase, orderId, user.id);
  if (!allowed) return { error: '无权撤回客户 PO' };
  if (!reason || reason.trim().length < 3) return { error: '请填写撤回原因' };

  const { data: attachment } = await (supabase.from('order_attachments') as any)
    .select('id, file_name, file_type')
    .eq('id', attachmentId)
    .eq('order_id', orderId)
    .maybeSingle();
  if (!attachment || attachment.file_type !== 'customer_po') return { error: '客户 PO 版本不存在' };

  await (supabase.from('order_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'customer_po_withdrawn',
    note: reason.trim(),
    payload: JSON.stringify({
      kind: 'customer_po_withdrawn',
      attachment_id: attachmentId,
      reason: reason.trim(),
      file_name: attachment.file_name || null,
    }),
    created_at: new Date().toISOString(),
  });

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
