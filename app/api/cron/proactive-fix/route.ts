/**
 * 主动问题发现与自动修复
 *
 * ⛔ [2026-04-27 System Consolidation Sprint] 已禁用
 * 原因：有自动修改数据副作用（assign owner / 修状态 / 清死锁节点），危险
 * 回滚：git revert 此文件，并在 vercel.json crons 重新加入调度条目
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { disabled: true, reason: 'proactive-fix disabled — auto-data-mutation risk (System Consolidation Sprint 2026-04-27)' },
    { status: 503 },
  );
}
