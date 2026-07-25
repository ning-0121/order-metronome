/**
 * 邮件归纳·晨间通知 Cron(Phase 2 E4,2026-07-25 CEO 批)。
 * 每天早上给每个业务执行发一条站内通知:近一天归属你的邮件 + 重点提示。读时零 AI。
 * 邮件外推按全局 kill-switch 仍关(email_sent:false);只走站内通知。
 * Vercel Cron: "0 1 * * *"(UTC 01:00 = 北京 09:00)。
 */

import { NextResponse } from 'next/server';
import { runDailyMailNotify } from '@/lib/email/daily-notify';

export const maxDuration = 30;

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runDailyMailNotify();
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[mail-digest-daily] 失败:', e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || 'notify failed' }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
