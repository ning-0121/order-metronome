// ============================================================
// Contract API v1 — 安全验证（finance/araos 签名，QIMO 验证）
// 算法对称于 finance src/lib/integration/security.ts：
//   HMAC-SHA256(secret, signString) hex + timingSafeEqual 恒定时间比较。
// GET 无 body，故 timestamp 走 header；规范串含 method/path/timestamp/apiKey。
// ============================================================

import { createHmac, createHash, timingSafeEqual } from 'crypto';
import type { ContractScope } from './scopes';
import { SCOPES } from './scopes';

/** timestamp 漂移窗口 ±300s（沿用 finance 5 分钟口径）。 */
export const DRIFT_MS = 300_000;

export type ConsumerKeyId = 'finance' | 'araos';

export interface ContractConsumer {
  token: string; // x-api-key 值（非密钥）
  keyId: ConsumerKeyId;
  scope: ContractScope;
  secret: string; // HMAC 密钥
}

export type AuthResult =
  | { ok: true; keyId: ConsumerKeyId; scope: ContractScope }
  | { ok: false; code: string; status: number };

/** 从 env 构建消费方注册表（缺失 key/secret 的条目自动跳过）。 */
export function getConsumers(): ContractConsumer[] {
  const list: ContractConsumer[] = [];
  const fk = process.env.CONTRACT_KEY_FINANCE;
  const fs = process.env.CONTRACT_SECRET_FINANCE;
  if (fk && fs) list.push({ token: fk, keyId: 'finance', scope: SCOPES.FINANCE_READ, secret: fs });
  const ak = process.env.CONTRACT_KEY_ARAOS;
  const as = process.env.CONTRACT_SECRET_ARAOS;
  if (ak && as) list.push({ token: ak, keyId: 'araos', scope: SCOPES.COMMERCIAL_READ, secret: as });
  return list;
}

/** 恒定时间字符串比较（长度不等直接 false，避免 timingSafeEqual 抛错）。 */
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

/**
 * 规范签名串。GET 无 body → 4 段(method/path/timestamp/apiKey),兼容现有只读路由。
 * POST 写 → 传 bodyHash(sha256(rawBody) hex)追加为第 5 段,防篡改 body。消费方须同口径。
 */
export function buildSignString(method: string, path: string, timestamp: string, apiKey: string, bodyHash?: string): string {
  const base = [method.toUpperCase(), path, timestamp, apiKey];
  if (bodyHash) base.push(bodyHash);
  return base.join('\n');
}

/** sha256 hex(用于 POST body hash;与消费方口径一致)。 */
export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** HMAC-SHA256 hex。 */
export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** 验证一个入站只读契约请求。path 为 pathname(+search)。 */
export function verifyContractRequest(opts: {
  method: string;
  path: string;
  apiKey: string | null;
  timestamp: string | null;
  signature: string | null;
  now: number;
  bodyHash?: string; // POST 写:sha256(rawBody);GET 省略保持 4 段签名(向后兼容)
}): AuthResult {
  const { method, path, apiKey, timestamp, signature, now, bodyHash } = opts;

  if (!apiKey) return { ok: false, code: 'missing_api_key', status: 401 };

  const consumer = getConsumers().find((c) => safeEqual(c.token, apiKey));
  if (!consumer) return { ok: false, code: 'invalid_api_key', status: 401 };

  if (!timestamp) return { ok: false, code: 'timestamp_expired', status: 401 };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > DRIFT_MS) {
    return { ok: false, code: 'timestamp_expired', status: 401 };
  }

  if (!signature) return { ok: false, code: 'invalid_signature', status: 401 };
  const expected = hmacHex(consumer.secret, buildSignString(method, path, timestamp, apiKey, bodyHash));
  if (!safeEqual(signature, expected)) return { ok: false, code: 'invalid_signature', status: 401 };

  return { ok: true, keyId: consumer.keyId, scope: consumer.scope };
}
