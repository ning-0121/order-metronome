/**
 * 生产排单每日提醒 Cron(2026-07-26 CEO)。每天给生产主管发一条汇总:
 * 新进生产单 / 料齐可排单 / 料齐待排超时(硬督办,抄送行政督办)。汇成每日一条,不刷屏。
 * Vercel Cron: "0 1 * * *"(UTC 01:00 = 北京 09:00)。
 */

import { NextResponse } from 'next/server';
import { runSchedulingReminder } from '@/lib/production/scheduling-reminder';

export const maxDuration = 60;

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runSchedulingReminder();
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[production-scheduling-reminder] 失败:', e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || 'reminder failed' }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
