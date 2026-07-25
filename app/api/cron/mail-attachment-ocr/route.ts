/**
 * 邮件附件 PO OCR Cron(Phase 3 T2b,2026-07-26 CEO 批)。
 * 对 mail_attachments 里 is_po 的 PDF 跑 Claude Vision 提 PO 要点。
 * 独立 cron、小批量、每 30 分钟一次 —— 与收信/归纳错峰,不抢它们的时间预算;Vision 贵故限量。
 */

import { NextResponse } from 'next/server';
import { runMailAttachmentOCR } from '@/lib/email/attachment-ocr';

export const maxDuration = 60;

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runMailAttachmentOCR(4);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[mail-attachment-ocr] 失败:', e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || 'ocr failed' }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
