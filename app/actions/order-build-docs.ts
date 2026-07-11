'use server';

/**
 * 建单附件 → 财务共享 + PO审批处可见(2026-07-11)。
 * 需求:建单必传「客户PO + 内部报价单」;报价单即时共享财务;财务审批PO时看到两份附件。
 * - shareBuildDocsToFinance:建单后即时把 customer_po + internal_quote 推外部财务系统(file.uploaded webhook)。
 * - getPoApprovalDocs:PO确认节点内联展示两份附件(角色门:finance/admin/负责人/业务经理)。
 */

import { createClient } from '@/lib/supabase/server';
import { syncFileToFinance } from '@/lib/integration/finance-sync';

const BUILD_DOC_TYPES = ['customer_po', 'internal_quote'] as const;

/** 文件名/mime → 财务 uploaded_documents.file_type CHECK 仅收 excel/pdf/image/word。 */
function financeFileType(name?: string, mime?: string): 'excel' | 'pdf' | 'image' | 'word' {
  const n = (name || '').toLowerCase();
  const m = (mime || '').toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n) || /sheet|excel|csv/.test(m)) return 'excel';
  if (/\.pdf$/.test(n) || /pdf/.test(m)) return 'pdf';
  if (/\.(jpe?g|png|gif|webp|bmp)$/.test(n) || m.startsWith('image/')) return 'image';
  if (/\.docx?$/.test(n) || /word|msword|officedocument\.wordprocessing/.test(m)) return 'word';
  return 'pdf';   // 兜底:财务侧当通用文档
}

/**
 * 建单后即时把「客户PO + 内部报价单」推送外部财务系统(file.uploaded)。
 * fire-and-forget,绝不阻断建单;未配 FINANCE_SYSTEM_URL env 时 syncFileToFinance 内部静默跳过。
 */
export async function shareBuildDocsToFinance(orderId: string): Promise<{ ok: boolean; sent?: string[] }> {
  try {
    const supabase = await createClient();
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no, internal_order_no, po_number, customer_name').eq('id', orderId).maybeSingle();
    const { data: atts } = await (supabase.from('order_attachments') as any)
      .select('id, file_name, file_type, file_url, storage_path, file_size, mime_type')
      .eq('order_id', orderId).in('file_type', BUILD_DOC_TYPES as unknown as string[]);
    if (!atts || atts.length === 0) return { ok: true, sent: [] };

    const sent: string[] = [];
    for (const a of atts) {
      try {
        let url: string | null = a.file_url || null;
        if (!url && a.storage_path) {
          const { data: pub } = supabase.storage.from('order-docs').getPublicUrl(a.storage_path);
          url = pub?.publicUrl || null;
        }
        if (!url) continue;
        await syncFileToFinance({
          id: `ordoc-${a.id}`,                        // 按附件 id 幂等,重发去重
          file_name: a.file_name || a.file_type,
          file_type: financeFileType(a.file_name, a.mime_type),
          file_size: Number(a.file_size) || 0,
          file_url: url,
          matched_customer: order?.customer_name ?? null,
          extracted_fields: {
            source: 'order-metronome/build-docs',
            doc_kind: a.file_type,                    // customer_po | internal_quote
            order_id: orderId,
            order_no: order?.order_no ?? null,
            internal_order_no: order?.internal_order_no ?? null,
            po_number: order?.po_number ?? null,
          },
        });
        sent.push(a.file_type);
      } catch (e: any) { console.warn('[shareBuildDocsToFinance] 单张推送失败(不阻断):', e?.message); }
    }
    return { ok: true, sent };
  } catch (e: any) {
    console.warn('[shareBuildDocsToFinance] 推财务失败(不阻断):', e?.message);
    return { ok: false };
  }
}

/**
 * PO确认节点内联展示用:取本单「客户PO + 内部报价单」附件(下载链接)。
 * 角色门:仅 finance/admin/订单创建者/负责人/业务经理 可见(与订单详情敏感文件口径一致),否则空。
 */
export async function getPoApprovalDocs(
  orderId: string,
): Promise<{ docs?: Array<{ id: string; file_type: string; file_name: string; url: string | null }>; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('created_by, owner_user_id').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canSee = roles.includes('admin') || roles.includes('finance') || roles.includes('sales_manager')
    || (order as any).created_by === user.id || (order as any).owner_user_id === user.id;
  if (!canSee) return { docs: [] };   // 无权看敏感文件 → 不报错,静默空

  const { data: atts } = await (supabase.from('order_attachments') as any)
    .select('id, file_type, file_name, file_url, storage_path')
    .eq('order_id', orderId).in('file_type', BUILD_DOC_TYPES as unknown as string[])
    .order('created_at', { ascending: true });

  const docs = ((atts || []) as any[]).map((a) => {
    let url: string | null = a.file_url || null;
    if (!url && a.storage_path) {
      const { data: pub } = supabase.storage.from('order-docs').getPublicUrl(a.storage_path);
      url = pub?.publicUrl || null;
    }
    return { id: a.id, file_type: a.file_type, file_name: a.file_name || a.file_type, url };
  });
  return { docs };
}
