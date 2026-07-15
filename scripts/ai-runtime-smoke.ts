/**
 * Paid, read-only Runtime smoke test. Disabled unless explicitly opted in.
 * This calls OpenAI directly through the provider adapter: no gateway retry,
 * no fallback, no database access, and at most one Responses API request.
 */
import { OpenAIAdapter } from '@/lib/ai/runtime/providers/openai';
import type { SchemaValidator } from '@/lib/ai/runtime/contracts';
import { AIRuntimeError } from '@/lib/ai/runtime/errors';

const allowed = process.env.QIMO_ALLOW_PAID_SMOKE_TEST === 'true';
if (!allowed) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: 'QIMO_ALLOW_PAID_SMOKE_TEST is not true' }));
  process.exit(0);
}

const model = process.env.QIMO_MODEL_STRUCTURED_EXTRACTION?.trim();
if (!process.env.OPENAI_API_KEY || !model || model.includes('=')) {
  console.log(JSON.stringify({
    ok: false,
    skipped: true,
    reason: !process.env.OPENAI_API_KEY
      ? 'Missing OPENAI_API_KEY'
      : 'QIMO_MODEL_STRUCTURED_EXTRACTION must be one explicit OpenAI model ID for this smoke test',
  }));
  process.exit(1);
}
const verifiedModel = model as string;

const schema: SchemaValidator<{ category: string; count: number }> = {
  name: 'qimo_runtime_smoke_v1',
  strict: true,
  jsonSchema: {
    type: 'object', additionalProperties: false, required: ['category', 'count'],
    properties: { category: { type: 'string' }, count: { type: 'number' } },
  },
  parse(value) {
    const row = value as { category?: unknown; count?: unknown } | null;
    if (!row || typeof row.category !== 'string' || typeof row.count !== 'number') throw new Error('schema mismatch');
    return { category: row.category, count: row.count };
  },
};

async function main(): Promise<void> {
try {
  const result = await new OpenAIAdapter().generateObject({
    scene: 'deployment.smoke.structured-extraction',
    capability: 'structured-extraction',
    logicalModel: 'qimo.structured-extraction',
    prompt: 'Classify this fixed non-sensitive record: category is sample and count is 2.',
    schema,
    timeoutMs: 20_000,
    maxOutputTokens: 64,
    fallback: 'disabled',
  }, verifiedModel);
  console.log(JSON.stringify({
    ok: true, provider: result.provider, model: result.model,
    latencyMs: result.latencyMs, usage: result.usage, vision: 'skipped-no-approved-test-image',
  }));
} catch (error) {
  const runtimeError = error instanceof AIRuntimeError ? error : undefined;
  console.log(JSON.stringify({
    ok: false, provider: runtimeError?.provider ?? 'openai', model: verifiedModel,
    errorCode: runtimeError?.code ?? 'UNKNOWN', vision: 'skipped-no-approved-test-image',
  }));
  process.exitCode = 1;
}
}

void main();
