/**
 * ⛔ [2026-07-28 第二轮审计] 已停用(僵尸路由收口)
 * 2026-04-27 System Consolidation Sprint 从 vercel.json 移除调度后,本路由活代码悬空:
 * 注释声称在跑、实际从不触发,误导维护者。本次统一转 503 停用桩。
 * agent-learn 的职责由现行 cron 覆盖(morning-briefing→daily-briefing;daily-summary→reminders 督办日报;
 * agent-scan/agent-learn→AI 巡检暂停)。
 * 回滚:git revert 此文件,并在 vercel.json crons 重新加入调度条目。
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { disabled: true, reason: 'agent-learn disabled — zombie route retired (audit 2026-07-28)' },
    { status: 503 },
  );
}
