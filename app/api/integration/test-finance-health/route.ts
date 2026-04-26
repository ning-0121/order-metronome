// ============================================================
// GET /api/integration/test-finance-health
// admin-only 诊断端点：验证 ENV 配置 + 财务 Agent 连通性
// 无副作用：只调对方 GET /health（不发任何 webhook 事件）
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkFinanceSystemHealth } from '@/lib/integration/finance-sync'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 仅 admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single()
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean)
  if (!roles.includes('admin')) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const apiKey = process.env.INTEGRATION_API_KEY || ''
  const secret = process.env.INTEGRATION_WEBHOOK_SECRET || ''
  const url = process.env.FINANCE_SYSTEM_URL || ''

  // ENV 状态报告（只显示长度和指纹，不泄露明文）
  const envSummary = {
    FINANCE_SYSTEM_URL: url
      ? `✓ ${url}`
      : '✗ missing',
    INTEGRATION_API_KEY: apiKey
      ? `✓ length=${apiKey.length}, fingerprint=${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
      : '✗ missing',
    INTEGRATION_WEBHOOK_SECRET: secret
      ? `✓ length=${secret.length}, fingerprint=${secret.slice(0, 4)}...${secret.slice(-4)}`
      : '✗ missing',
  }

  // 调 health（带 API Key header）
  const startedAt = Date.now()
  let healthOk = false
  let healthError: string | null = null
  try {
    healthOk = await checkFinanceSystemHealth()
  } catch (e: any) {
    healthError = e?.message || 'unknown error'
  }
  const elapsed = Date.now() - startedAt

  return NextResponse.json({
    env: envSummary,
    health_check: {
      target: url || '(FINANCE_SYSTEM_URL not configured)',
      passed: healthOk,
      elapsed_ms: elapsed,
      error: healthError,
    },
    next_steps: healthOk
      ? '✅ Health 通过。如要验证 API Key + Signature 是否完全匹配，需触发一次真业务事件（创建/更新订单等），然后看 Vercel logs 中是否有 "[FinanceSync] ... sent successfully"'
      : '❌ Health 失败。检查 ENV 是否配置正确、Vercel 是否已 redeploy（ENV 配置后必须重新部署才生效）',
    timestamp: new Date().toISOString(),
  })
}
