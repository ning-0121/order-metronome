/**
 * 邮件-订单执行对照 Cron
 *
 * ⛔ [2026-04-27 System Consolidation Sprint] 已禁用
 * 原因：compliance 规则未明确定义，AI 对照结果噪音多，compliance_findings 无 UI 消费
 * 回滚：git revert 此文件，并在 vercel.json crons 重新加入调度条目
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { disabled: true, reason: 'compliance-check disabled — rules undefined, high noise (System Consolidation Sprint 2026-04-27)' },
    { status: 503 },
  );
}

export async function POST() {
  return GET();
}
