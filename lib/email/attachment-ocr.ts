/**
 * 邮件附件 PO OCR(Phase 3 T2b,2026-07-26 CEO 批)。
 * 对 mail_attachments 里 is_po=true & 待处理的 PDF 跑 Claude Vision,提取 PO 要点,回填 extracted_json/summary。
 * 省 token:仅对疑似 PO 的 PDF 跑 Vision;每轮小批量(默认 4)封顶;失败标 failed 不卡队列。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';

const OCR_MODEL = 'claude-sonnet-5';   // 单据 OCR 要准度,用 Sonnet;靠"仅 is_po PDF + 小批量"控成本

const SYSTEM = `你是服装外贸单据解析引擎。从附件(通常是客户 PO/采购单)提取要点。
只提文件里明确存在的信息,不猜测补全;不提取价格。PO号=整单表头的单据编号(不是款号)。`;

const PROMPT = `返回 JSON(不要 markdown):
{"po_number":"PO号或null","customer_name":"客户名或null","delivery_date":"交期YYYY-MM-DD或null",
"style_count":款数整数或null,"total_quantity":总件数整数或null,
"summary":"一句话中文≤40字概括这份单据(谁的什么单、几款几件、交期)"}
只输出 JSON。`;

/** 跑一轮附件 OCR。返回处理计数。 */
export async function runMailAttachmentOCR(limit = 4): Promise<{ scanned: number; done: number; failed: number }> {
  const svc = createServiceRoleClient();
  const { data: rows } = await (svc.from('mail_attachments') as any)
    .select('id, mail_id, order_id, file_name, mime_type, storage_path')
    .eq('is_po', true).eq('ocr_status', 'pending')
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  const atts = (rows || []) as any[];
  if (atts.length === 0) return { scanned: 0, done: 0, failed: 0 };

  let done = 0, failed = 0;
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic();

  for (const att of atts) {
    try {
      const { data: blob, error: dlErr } = await svc.storage.from('order-docs').download(att.storage_path);
      if (dlErr || !blob) { await mark(svc, att.id, 'failed', null, null); failed++; continue; }
      const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
      const mime = String(att.mime_type || 'application/pdf').toLowerCase();
      const isPdf = mime.includes('pdf');
      const contentBlock: any = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: (mime.startsWith('image/') ? mime : 'image/jpeg'), data: base64 } };

      const resp = await client.messages.create({
        model: OCR_MODEL, max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }],
      });
      const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
      let json = raw.trim();
      if (json.startsWith('```')) json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(json);
      await mark(svc, att.id, 'done', parsed, String(parsed.summary || '').slice(0, 120));
      done++;
    } catch (e: any) {
      console.warn('[mail-ocr] 附件 OCR 失败:', att.file_name, e?.message);
      await mark(svc, att.id, 'failed', null, null);
      failed++;
    }
  }
  return { scanned: atts.length, done, failed };
}

async function mark(svc: any, id: string, status: string, json: any, summary: string | null): Promise<void> {
  try {
    await (svc.from('mail_attachments') as any).update({
      ocr_status: status, extracted_json: json, extract_summary: summary, ocr_at: new Date().toISOString(),
    }).eq('id', id);
  } catch { /* 标记失败不阻断 */ }
}
