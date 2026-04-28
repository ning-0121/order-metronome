/**
 * AI 自我改进
 *
 * ⛔ [2026-04-27 System Consolidation Sprint] 已禁用
 * 原因：伪自学习，无法真正改变模型行为，只写 ai_learning_log 制造噪音
 * 回滚：git revert 此文件，并在 vercel.json crons 重新加入调度条目
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { disabled: true, reason: 'ai-self-improve disabled — pseudo-learning, no real effect (System Consolidation Sprint 2026-04-27)' },
    { status: 503 },
  );
}
