// GET /api/os/handoff?target=<systemId>
// QIMO OS 受控跳转（Kernel v1 驱动）：权限判定全交 OSDecisionKernel，本路由**无任何策略逻辑**，
// 只执行裁决 + 边缘副作用（读 env 密钥、铸 BridgeSession、302）。只读 profiles；不写任何业务表。

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { OSDecisionKernel } from '@/lib/os/kernel';
import { getSystem } from '@/lib/os/registry';
import { signBridgeSession, BRIDGE_TTL_SEC, type BridgeSession } from '@/lib/os/bridge';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest) {
  const target = new URL(request.url).searchParams.get('target') || '';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));

  // 角色（复用现有 profiles.role/roles 口径）
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);

  // 唯一决策入口
  const decision = OSDecisionKernel({
    user: { id: user.id, email: user.email || user.id, roles },
    action: { type: 'ENTER_SYSTEM', targetSystem: target },
  });

  if (decision.entryMode === 'blocked') {
    const status = decision.reason === 'unknown_system' ? 404 : 403;
    return NextResponse.json({ error: decision.reason }, { status });
  }
  // 内部系统不经 handoff（Hub 内直达）
  if (decision.entryMode !== 'handoff') {
    return NextResponse.json({ error: 'internal_target_not_via_handoff' }, { status: 404 });
  }

  // ── 边缘副作用：env 密钥 + 铸令牌 + 跳转 ──
  const system = getSystem(target)!;
  const baseUrl = system.urlEnvKey ? process.env[system.urlEnvKey] : undefined;
  if (!baseUrl) return NextResponse.json({ error: `${target}_url_not_configured` }, { status: 503 });

  const secret = process.env[`OS_TOKEN_SECRET_${target.toUpperCase()}`];
  // 降级：目标未接 accept（无 secret）→ 普通受控跳转，不带令牌
  if (!secret) return NextResponse.redirect(baseUrl);

  const now = Math.floor(Date.now() / 1000);
  const session: BridgeSession = {
    session_id: randomUUID(),
    sub: user.email || user.id,
    roles,
    capabilities: decision.capabilities,
    aud: target,
    iat: now,
    exp: now + BRIDGE_TTL_SEC,
    jti: randomUUID(),
    nonce: randomUUID(),
    scope: decision.tokenScope ?? [],
  };
  const token = signBridgeSession(session, secret);

  const dest = new URL('/api/os/accept', baseUrl);
  dest.searchParams.set('token', token);
  return NextResponse.redirect(dest.toString());
}
