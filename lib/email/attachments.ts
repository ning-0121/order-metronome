/**
 * 邮件附件落库(2026-08-21 从 email-scan 抽出)。
 *
 * 原来是 app/api/cron/email-scan/route.ts 里的私有函数。把拉取拆成独立 cron
 * (email-fetch)后两边都要用 —— 与其复制一份,不如抽到这里,避免"两份实现各自演进"
 * (本仓库已有过 DEPT_TASK_BY_STEP 抄两份的教训)。
 *
 * 逐个附件独立 try:一个坏附件不该让整封邮件入库失败。
 */

import { upsertMailAttachment } from '@/lib/repositories/mailRepo';

/** 把邮件附件传到 order-docs 桶并登记 mail_attachments(供后续 Vision OCR)。 */
export async function storeMailAttachments(
  supabase: any,
  mailId: string,
  attachments: any[],
): Promise<void> {
  for (const att of attachments || []) {
    try {
      const safeName = String(att.filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);
      const path = `mail/${mailId}/${safeName}`;
      const isPdf = String(att.contentType || '').toLowerCase().includes('pdf');
      const { error: upErr } = await supabase.storage.from('order-docs')
        .upload(path, att.content, { contentType: att.contentType || 'application/octet-stream', upsert: true });
      if (upErr) { console.warn('[mail-attachments] 附件上传失败:', safeName, upErr.message); continue; }
      await upsertMailAttachment(supabase, {
        mail_id: mailId, file_name: safeName, mime_type: att.contentType || null,
        storage_path: path, size_bytes: att.size || null,
        is_po: isPdf, ocr_status: 'pending',
      });
    } catch (e: any) {
      console.warn('[mail-attachments] 附件处理异常(不阻断):', e?.message);
    }
  }
}
