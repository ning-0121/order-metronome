/**
 * 技术侦察员
 *
 * ⛔ [2026-04-27 System Consolidation Sprint] 已禁用
 * 原因：爬 GitHub 与订单业务无关，占用 Claude API 配额
 * 回滚：git revert 此文件，并在 vercel.json crons 重新加入调度条目
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { disabled: true, reason: 'tech-scout disabled — unrelated to order business (System Consolidation Sprint 2026-04-27)' },
    { status: 503 },
  );
}
