/**
 * 邮件归纳 Cron(Phase 1,2026-07-25 CEO 批)。
 * 增量拉未归纳邮件 → 规则分类(噪音零 AI)→ Haiku 批量摘要 → 物化 mail_inbox 归纳列。
 * 与 email-scan 错峰(email-scan 收信在 :05/:20/:35/:50,本 job 在 :10/:25/:40/:55 归纳新信)。
 * 省 token:一批一调用 + Haiku + system 缓存 + 只处理 digested_at IS NULL。
 */

import { NextResponse } from 'next/server';
import { runMailDigest } from '@/lib/email/digest-engine';

export const maxDuration = 60;

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    // 一轮最多 30 封,配合 60s 预算;量大时下一轮 cron 继续消化增量队列
    const result = await runMailDigest(30);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[mail-digest] 失败:', e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || 'digest failed' }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
