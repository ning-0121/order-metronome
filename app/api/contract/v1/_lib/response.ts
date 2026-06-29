// ============================================================
// Contract API v1 — 统一响应封套（含 schema_version；错误无堆栈）
// ============================================================

import { NextResponse } from 'next/server';

export const SCHEMA_VERSION = 'v1' as const;

/** 成功响应：注入 schema_version。 */
export function ok(data: Record<string, unknown>): NextResponse {
  return NextResponse.json({ schema_version: SCHEMA_VERSION, ...data }, { status: 200 });
}

const DEFAULT_MESSAGES: Record<string, string> = {
  missing_api_key: 'Missing x-api-key header',
  invalid_api_key: 'Unrecognized API key',
  invalid_signature: 'Invalid request signature',
  timestamp_expired: 'Request timestamp missing or outside allowed window',
  insufficient_scope: 'API key scope is not permitted for this resource',
  not_found: 'Resource not found',
  internal_error: 'Internal error',
};

/** 失败响应：统一 { error: { code, message } }，不泄内部细节。 */
export function fail(code: string, status: number, message?: string): NextResponse {
  return NextResponse.json(
    { schema_version: SCHEMA_VERSION, error: { code, message: message ?? DEFAULT_MESSAGES[code] ?? code } },
    { status },
  );
}
