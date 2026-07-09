/**
 * QIMO OS — 短时受控跳转令牌（Unified Access Layer · Phase A）
 *
 * QIMO 铸造，外部系统（finance/araos）验证后建本地会话 → 免二次登录。
 * 无状态（不落库，故无 migration）。签名口径复用 Contract API HMAC-SHA256。
 * 目标系统的 accept 端点用同一算法验签（规范见 docs/integration/13-...）。
 */

import { createHmac, timingSafeEqual } from 'crypto';

export interface OsHandoffClaims {
  /** 员工身份锚：QIMO 邮箱（Phase 2 换 WeCom 目录） */
  sub: string;
  roles: string[];
  /** 目标系统 id（audience，绑定防跨目标重放） */
  aud: string;
  /** 签发/过期（Unix 秒） */
  iat: number;
  exp: number;
  nonce: string;
}

/** 规范签名串（确定性、字段固定顺序）。铸/验两侧必须一致拼装。 */
export function canonicalizeClaims(c: OsHandoffClaims): string {
  return [c.sub, c.roles.join(','), c.aud, String(c.iat), String(c.exp), c.nonce].join('\n');
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

/** 铸令牌：base64url(claims JSON) + '.' + HMAC-SHA256(canonical)。纯函数（时间/nonce 由调用方给）。 */
export function signClaims(claims: OsHandoffClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', secret).update(canonicalizeClaims(claims)).digest('hex');
  return `${body}.${sig}`;
}

/** 时效 + audience 校验（不含签名）。 */
export function validateClaims(
  c: OsHandoffClaims,
  expectedAud: string,
  nowSec: number,
): { ok: boolean; reason?: string } {
  if (c.aud !== expectedAud) return { ok: false, reason: 'aud_mismatch' };
  if (nowSec > c.exp) return { ok: false, reason: 'expired' };
  if (c.iat > nowSec + 60) return { ok: false, reason: 'iat_future' };
  return { ok: true };
}

export type VerifyResult =
  | { ok: true; claims: OsHandoffClaims }
  | { ok: false; reason: string };

/** 验令牌：拆包 → 验签 → 时效/aud 校验。目标系统 accept 端点的参考实现。 */
export function verifyToken(token: string, secret: string, expectedAud: string, nowSec: number): VerifyResult {
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let claims: OsHandoffClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  if (!claims || typeof claims.sub !== 'string' || !Array.isArray(claims.roles)) {
    return { ok: false, reason: 'bad_claims' };
  }

  const expected = createHmac('sha256', secret).update(canonicalizeClaims(claims)).digest('hex');
  if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };

  const v = validateClaims(claims, expectedAud, nowSec);
  if (!v.ok) return { ok: false, reason: v.reason! };
  return { ok: true, claims };
}
