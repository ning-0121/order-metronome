// ============================================================
// Contract API v1 — 访问审计日志（best-effort；失败绝不阻断响应）
// 绝不写：请求 body / 财务原值 / 真实密钥。key_id 只记 finance|araos|unknown。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/server';

export interface AccessLogRow {
  key_id: string; // 'finance' | 'araos' | 'unknown'
  scope?: string | null;
  method: string;
  route: string; // 路由模板，如 /api/contract/v1/orders/:id
  qimo_entity_type?: string | null;
  qimo_entity_id?: string | null;
  request_id?: string | null;
  status_code: number;
  outcome: string; // ok | unauthorized | forbidden | not_found | error
  error_code?: string | null;
  ip?: string | null;
  latency_ms?: number | null;
}

/** 写一行访问日志。任何失败都被吞掉（不抛、不阻断契约响应）。 */
export async function writeAccessLog(row: AccessLogRow): Promise<void> {
  try {
    const sb = createServiceRoleClient() as unknown as SupabaseClient;
    await sb.from('contract_access_log').insert({
      key_id: row.key_id,
      scope: row.scope ?? null,
      method: row.method,
      route: row.route,
      qimo_entity_type: row.qimo_entity_type ?? null,
      qimo_entity_id: row.qimo_entity_id ?? null,
      request_id: row.request_id ?? null,
      status_code: row.status_code,
      outcome: row.outcome,
      error_code: row.error_code ?? null,
      ip: row.ip ?? null,
      latency_ms: row.latency_ms ?? null,
    });
  } catch {
    // 日志失败不影响契约响应
  }
}
