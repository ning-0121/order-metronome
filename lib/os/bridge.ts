/**
 * QIMO OS — BridgeSession（Phase A+ 令牌升级）
 *
 * 把 Phase A 短时 token 升级为带 jti + scope + capabilities 的会话契约。
 * 签名口径仍是 HMAC-SHA256（复用 Contract 模式）；无状态（不落库）。
 * 目标系统 /api/os/accept 用同算法验签（规范见 docs/integration/14-...）。
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Capability } from './capabilities';

export interface BridgeSession {
  session_id: string;
  sub: string; // 员工邮箱
  roles: string[];
  capabilities: Capability[]; // 全量能力
  aud: string; // 目标系统 id（audience 绑定）
  iat: number;
  exp: number;
  jti: string; // 唯一 id（重放防护锚）
  nonce: string;
  scope: Capability[]; // per-system 限缩能力
}

export const BRIDGE_TTL_SEC = 90;

/** 规范签名串（铸/验必须一致，固定顺序）。 */
export function canonicalizeSession(s: BridgeSession): string {
  return [
    s.session_id,
    s.sub,
    s.roles.join(','),
    s.capabilities.join(','),
    s.aud,
    String(s.iat),
    String(s.exp),
    s.jti,
    s.nonce,
    s.scope.join(','),
  ].join('\n');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** 铸 BridgeSession token：base64url(session JSON) + '.' + HMAC。纯函数。 */
export function signBridgeSession(session: BridgeSession, secret: string): string {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const sig = createHmac('sha256', secret).update(canonicalizeSession(session)).digest('hex');
  return `${body}.${sig}`;
}

export interface VerifyOpts {
  /** 可选 jti 重放检查（目标系统传入 jtiStore.isJtiSeen）。 */
  jtiSeen?: (jti: string) => boolean;
}

export type BridgeVerifyResult =
  | { ok: true; session: BridgeSession }
  | { ok: false; reason: string };

/** 验 BridgeSession：验签 → aud → 时效 → jti 重放。目标 accept 端点参考实现。 */
export function verifyBridgeSession(
  token: string,
  secret: string,
  expectedAud: string,
  nowSec: number,
  opts: VerifyOpts = {},
): BridgeVerifyResult {
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let s: BridgeSession;
  try {
    s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  if (
    !s || typeof s.sub !== 'string' || !Array.isArray(s.roles) ||
    typeof s.jti !== 'string' || typeof s.aud !== 'string'
  ) {
    return { ok: false, reason: 'bad_session' };
  }

  const expected = createHmac('sha256', secret).update(canonicalizeSession(s)).digest('hex');
  if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };
  if (s.aud !== expectedAud) return { ok: false, reason: 'aud_mismatch' };
  if (nowSec > s.exp) return { ok: false, reason: 'expired' };
  if (s.iat > nowSec + 60) return { ok: false, reason: 'iat_future' };
  if (opts.jtiSeen && opts.jtiSeen(s.jti)) return { ok: false, reason: 'jti_replay' };

  return { ok: true, session: s };
}
