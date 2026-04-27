// ============================================================
// POST /api/integration/test-finance-sync
// admin-only 主动诊断：立即发送一次 webhook ping 到财务 Agent
// 返回完整的 request URL + response status + body，便于双方比对 integration_logs
//
// 不依赖任何业务动作触发，不污染数据（用 event=test.ping，对方会 log 但拒绝处理）
// ============================================================

import { NextResponse } from 'next/server'
import { createHmac } from 'crypto'
import { createClient } from '@/lib/supabase/server'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  // 读 ENV
  const FINANCE_SYSTEM_URL = process.env.FINANCE_SYSTEM_URL || ''
  const INTEGRATION_API_KEY = process.env.INTEGRATION_API_KEY || ''
  const INTEGRATION_WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

  // 检查 ENV 完整性
  const envCheck: any = {
    FINANCE_SYSTEM_URL_present: !!FINANCE_SYSTEM_URL,
    FINANCE_SYSTEM_URL_value: FINANCE_SYSTEM_URL,
    FINANCE_SYSTEM_URL_has_trailing_slash: FINANCE_SYSTEM_URL.endsWith('/'),
    INTEGRATION_API_KEY_present: !!INTEGRATION_API_KEY,
    INTEGRATION_API_KEY_length: INTEGRATION_API_KEY.length,
    INTEGRATION_API_KEY_fingerprint: INTEGRATION_API_KEY
      ? `${INTEGRATION_API_KEY.slice(0, 4)}...${INTEGRATION_API_KEY.slice(-4)}`
      : '(missing)',
    INTEGRATION_WEBHOOK_SECRET_present: !!INTEGRATION_WEBHOOK_SECRET,
    INTEGRATION_WEBHOOK_SECRET_length: INTEGRATION_WEBHOOK_SECRET.length,
    INTEGRATION_WEBHOOK_SECRET_fingerprint: INTEGRATION_WEBHOOK_SECRET
      ? `${INTEGRATION_WEBHOOK_SECRET.slice(0, 4)}...${INTEGRATION_WEBHOOK_SECRET.slice(-4)}`
      : '(missing)',
  }

  if (!FINANCE_SYSTEM_URL || !INTEGRATION_API_KEY || !INTEGRATION_WEBHOOK_SECRET) {
    return NextResponse.json({
      ok: false,
      stage: 'env_check',
      error: 'ENV 配置缺失，节拍器不会发送 webhook（finance-sync.ts L42-45 的兜底逻辑会静默跳过）',
      env: envCheck,
    })
  }

  // 拼接 URL（与 finance-sync.ts 完全一致）
  const fullUrl = `${FINANCE_SYSTEM_URL}/api/integration/webhook`

  // 构造 payload（完全模仿 finance-sync.ts 的双签名逻辑）
  const requestId = `om-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const payload: any = {
    event: 'test.ping',
    timestamp: new Date().toISOString(),
    source: 'order-metronome',
    request_id: requestId,
    data: {
      ping: true,
      from: 'admin diagnostic endpoint /api/integration/test-finance-sync',
      triggered_by_user_id: user.id,
    },
    signature: '',
  }

  function signHmac(text: string): string {
    return createHmac('sha256', INTEGRATION_WEBHOOK_SECRET).update(text).digest('hex')
  }

  const unsignedBody = JSON.stringify(payload)
  payload.signature = signHmac(unsignedBody)
  const signedBody = JSON.stringify(payload)
  const headerSignature = signHmac(signedBody)

  // 真发送
  const startedAt = Date.now()
  let responseStatus = 0
  let responseBody = ''
  let responseHeaders: Record<string, string> = {}
  let networkError: string | null = null

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': INTEGRATION_API_KEY,
        'x-webhook-signature': headerSignature,
        'x-source': 'order-metronome',
      },
      body: signedBody,
      signal: AbortSignal.timeout(15_000),
    })
    responseStatus = response.status
    responseBody = await response.text()
    response.headers.forEach((v, k) => { responseHeaders[k] = v })
  } catch (e: any) {
    networkError = e?.message || 'unknown network error'
  }
  const elapsed = Date.now() - startedAt

  return NextResponse.json({
    ok: !networkError && responseStatus < 500,
    stage: networkError ? 'fetch_failed' : 'response_received',
    env: envCheck,
    request: {
      url: fullUrl,
      method: 'POST',
      headers_summary: {
        'x-api-key': `${INTEGRATION_API_KEY.slice(0, 4)}...${INTEGRATION_API_KEY.slice(-4)}`,
        'x-webhook-signature': headerSignature.slice(0, 16) + '...',
        'x-source': 'order-metronome',
      },
      body_event: payload.event,
      body_request_id: requestId,
      body_size: signedBody.length,
    },
    response: networkError
      ? null
      : {
          status: responseStatus,
          headers: responseHeaders,
          body: responseBody.slice(0, 2000),
          body_truncated: responseBody.length > 2000,
        },
    network_error: networkError,
    elapsed_ms: elapsed,
    interpretation: networkError
      ? `❌ 网络层失败：${networkError}（DNS/防火墙/TLS 问题，对方完全收不到）`
      : responseStatus === 401
      ? '⚠️ 401 Unauthorized — API Key 或 Signature 不匹配，但请求已到达对方系统（应该出现在他们的 integration_logs）'
      : responseStatus === 403
      ? '⚠️ 403 Forbidden — origin 白名单或 source 拒绝，请求已到达'
      : responseStatus === 404
      ? '⚠️ 404 Not Found — URL 错误，路径或域名拼错'
      : responseStatus >= 200 && responseStatus < 300
      ? '✅ 2xx 成功 — 完整链路通'
      : `⚠️ HTTP ${responseStatus} — 请求已到达，请看 response.body`,
    next_step_for_finance_team: networkError
      ? '财务侧无需做任何事 — 我们这边网络层就失败了'
      : '请财务团队查 integration_logs 表，应该能找到 request_id=' + requestId + ' 的记录',
  })
}
