import { createHash, timingSafeEqual } from 'node:crypto';
import type { UsageMetadata } from '@/lib/ai/runtime/contracts';

export interface SmokeExecutionResult {
  provider: 'openai'; model: string; latencyMs: number; usage: UsageMetadata;
  schemaValid: boolean; fieldMatchCount: number;
}

interface SmokeDependencies {
  environment(): string | undefined;
  token(): string | undefined;
  nonce(): string | undefined;
  execute(): Promise<SmokeExecutionResult>;
  state: { isConsumed(): boolean; consume(): void };
}

function secureEqual(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function response(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

async function acceptsFixedBody(request: Request): Promise<boolean> {
  const raw = await request.text();
  if (!raw.trim()) return true;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.keys(parsed).length === 1 && parsed.action === 'run';
  } catch { return false; }
}

export function createSmokePostHandler(dependencies: SmokeDependencies) {
  return async function POST(request: Request): Promise<Response> {
    if (dependencies.environment() !== 'preview') return response(404, { ok: false, errorCode: 'NOT_FOUND' });
    const token = request.headers.get('x-qimo-smoke-token');
    const nonce = request.headers.get('x-qimo-smoke-nonce');
    if (!secureEqual(token, dependencies.token()) || !secureEqual(nonce, dependencies.nonce())) {
      return response(401, { ok: false, errorCode: 'UNAUTHORIZED' });
    }
    if (!await acceptsFixedBody(request)) return response(400, { ok: false, errorCode: 'INVALID_REQUEST' });
    if (dependencies.state.isConsumed()) return response(410, { ok: false, errorCode: 'ALREADY_CONSUMED' });
    dependencies.state.consume();
    try {
      return response(200, { ok: true, ...await dependencies.execute(), errorCode: null });
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'SMOKE_FAILED') : 'SMOKE_FAILED';
      return response(502, { ok: false, schemaValid: false, errorCode });
    }
  };
}

export function methodNotAllowed(): Response {
  return response(405, { ok: false, errorCode: 'METHOD_NOT_ALLOWED' });
}
