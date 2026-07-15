import { OpenAIAdapter } from '@/lib/ai/runtime/providers/openai';
import type { SchemaValidator } from '@/lib/ai/runtime/contracts';
import { createSmokePostHandler, methodNotAllowed } from './smoke-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SmokePO {
  poNumber: string;
  customer: string;
  style: string;
  quantity: number;
  currency: string;
}

const expected: SmokePO = {
  poNumber: 'TEST-001', customer: 'Demo Customer', style: 'ABC123', quantity: 1200, currency: 'USD',
};

const schema: SchemaValidator<SmokePO> = {
  name: 'qimo_preview_smoke_v1',
  strict: true,
  jsonSchema: {
    type: 'object', additionalProperties: false,
    required: ['poNumber', 'customer', 'style', 'quantity', 'currency'],
    properties: {
      poNumber: { type: 'string' }, customer: { type: 'string' }, style: { type: 'string' },
      quantity: { type: 'number' }, currency: { type: 'string' },
    },
  },
  parse(value) {
    const row = value as Partial<SmokePO> | null;
    if (!row || typeof row.poNumber !== 'string' || typeof row.customer !== 'string'
      || typeof row.style !== 'string' || typeof row.quantity !== 'number'
      || typeof row.currency !== 'string') throw Object.assign(new Error('schema mismatch'), { code: 'SCHEMA_MISMATCH' });
    return row as SmokePO;
  },
};

let consumed = false;

export const POST = createSmokePostHandler({
  environment: () => process.env.VERCEL_ENV,
  token: () => process.env.QIMO_SMOKE_TEST_TOKEN,
  nonce: () => process.env.QIMO_SMOKE_TEST_NONCE,
  state: { isConsumed: () => consumed, consume: () => { consumed = true; } },
  async execute() {
    const model = process.env.QIMO_MODEL_STRUCTURED_EXTRACTION?.trim();
    if (!model) throw Object.assign(new Error('model not configured'), { code: 'MODEL_NOT_CONFIGURED' });
    const result = await new OpenAIAdapter().generateObject({
      scene: 'preview.internal.structured-smoke',
      capability: 'structured-extraction',
      logicalModel: 'qimo.structured-extraction',
      prompt: 'PO number TEST-001, customer Demo Customer, style ABC123, quantity 1200, currency USD.',
      schema,
      timeoutMs: 20_000,
      maxOutputTokens: 64,
      fallback: 'disabled',
    }, model);
    const fields = Object.keys(expected) as Array<keyof SmokePO>;
    const matches = fields.filter(field => result.data[field] === expected[field]).length;
    return {
      provider: 'openai', model: result.model, latencyMs: result.latencyMs, usage: result.usage,
      schemaValid: true, fieldMatchCount: matches,
    };
  },
});

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
