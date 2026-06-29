// ============================================================
// Contract API v1 — 高阶包装：auth → 执行 handler → 退出写 access log → 错误映射
// 让每个 route 极薄、安全/日志口径统一。
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyContractRequest } from './auth';
import type { ContractScope } from './scopes';
import { scopeSatisfies } from './scopes';
import { ok, fail } from './response';
import { writeAccessLog } from './log';

export interface ContractHandlerCtx<P> {
  params: P;
  scope: ContractScope;
  keyId: 'finance' | 'araos';
  supabase: SupabaseClient;
  request: Request;
}

/** handler 返回 { entityId, data } = 命中；返回 null = not_found。 */
export type ContractHandler<P> = (
  ctx: ContractHandlerCtx<P>,
) => Promise<{ entityId: string | null; data: Record<string, unknown> } | null>;

export interface ContractOpts {
  routeTemplate: string; // /api/contract/v1/orders/:id
  entityType: string; // order
  requiredScope?: ContractScope; // 仅 finance/* 端点设置
}

function clientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

export function withContract<P extends Record<string, string> = Record<string, string>>(
  opts: ContractOpts,
  handler: ContractHandler<P>,
) {
  return async (request: Request, routeCtx: { params: Promise<P> }): Promise<NextResponse> => {
    const t0 = Date.now();
    const url = new URL(request.url);
    const path = url.pathname + (url.search || '');
    const ip = clientIp(request);
    const requestId = request.headers.get('x-request-id'); // 只读可选，仅留痕

    const base = {
      method: request.method,
      route: opts.routeTemplate,
      qimo_entity_type: opts.entityType,
      request_id: requestId,
      ip,
    };

    const auth = verifyContractRequest({
      method: request.method,
      path,
      apiKey: request.headers.get('x-api-key'),
      timestamp: request.headers.get('x-timestamp'),
      signature: request.headers.get('x-signature'),
      now: t0,
    });

    if (!auth.ok) {
      await writeAccessLog({
        ...base,
        key_id: 'unknown',
        status_code: auth.status,
        outcome: 'unauthorized',
        error_code: auth.code,
        latency_ms: Date.now() - t0,
      });
      return fail(auth.code, auth.status);
    }

    if (opts.requiredScope && !scopeSatisfies(auth.scope, opts.requiredScope)) {
      await writeAccessLog({
        ...base,
        key_id: auth.keyId,
        scope: auth.scope,
        status_code: 403,
        outcome: 'forbidden',
        error_code: 'insufficient_scope',
        latency_ms: Date.now() - t0,
      });
      return fail('insufficient_scope', 403);
    }

    try {
      const params = await routeCtx.params;
      const entityIdParam = (params as Record<string, string>).id ?? null;
      const supabase = createServiceRoleClient() as unknown as SupabaseClient;
      const result = await handler({ params, scope: auth.scope, keyId: auth.keyId, supabase, request });

      if (!result) {
        await writeAccessLog({
          ...base,
          key_id: auth.keyId,
          scope: auth.scope,
          qimo_entity_id: entityIdParam,
          status_code: 404,
          outcome: 'not_found',
          error_code: 'not_found',
          latency_ms: Date.now() - t0,
        });
        return fail('not_found', 404);
      }

      await writeAccessLog({
        ...base,
        key_id: auth.keyId,
        scope: auth.scope,
        qimo_entity_id: result.entityId,
        status_code: 200,
        outcome: 'ok',
        latency_ms: Date.now() - t0,
      });
      return ok(result.data);
    } catch {
      await writeAccessLog({
        ...base,
        key_id: auth.keyId,
        scope: auth.scope,
        status_code: 500,
        outcome: 'error',
        error_code: 'internal_error',
        latency_ms: Date.now() - t0,
      });
      return fail('internal_error', 500);
    }
  };
}
