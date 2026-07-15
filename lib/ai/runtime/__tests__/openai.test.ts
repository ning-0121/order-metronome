import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Response } from 'openai/resources/responses/responses';
import type { SchemaValidator, VisionRequest } from '../contracts';
import { AIRuntimeError } from '../errors';
import { buildOpenAIObjectInput, buildOpenAIVisionInput, OpenAIAdapter } from '../providers/openai';

const envKey = process.env.OPENAI_API_KEY;
beforeEach(() => { process.env.OPENAI_API_KEY = 'test-only-key'; });
afterEach(() => { if (envKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = envKey; });

const schema: SchemaValidator<{ value: string }> = {
  name: 'test_object',
  jsonSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
  parse(value) {
    if (!value || typeof value !== 'object' || typeof (value as { value?: unknown }).value !== 'string') throw new Error('schema mismatch');
    return value as { value: string };
  },
};

function response(outputText: string, content?: Array<Record<string, unknown>>): Response {
  return {
    id: 'resp_test', _request_id: 'req_test', object: 'response', created_at: 0, status: 'completed',
    completed_at: 0, error: null, incomplete_details: null, instructions: null, max_output_tokens: 10,
    model: 'configured-model', output_text: outputText,
    output: [{ id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: (content ?? [{ type: 'output_text', text: outputText, annotations: [], logprobs: [] }]) as never }],
    parallel_tool_calls: false, temperature: null, tool_choice: 'auto', tools: [], top_p: null,
    usage: { input_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 5 },
  } as unknown as Response;
}

function mockAdapter(value: Response) {
  return new OpenAIAdapter(() => ({ responses: { create: async () => value } } as never));
}

const objectRequest = { scene: 'test.object', capability: 'structured-extraction' as const, prompt: 'extract', schema };

describe('OpenAI structured output', () => {
  it('returns validated JSON and usage', async () => {
    const result = await mockAdapter(response('{"value":"ok"}')).generateObject(objectRequest, 'configured-model');
    assert.deepEqual(result.data, { value: 'ok' });
    assert.equal(result.usage.cachedInputTokens, 1);
  });

  it('passes a real abort signal and terminates at the runtime timeout', async () => {
    let observedSignal: AbortSignal | undefined;
    const adapter = new OpenAIAdapter(() => ({ responses: { create: async (_body: unknown, options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      await new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
      return response('never');
    } } } as never));
    await assert.rejects(adapter.generateObject({ ...objectRequest, timeoutMs: 5 }, 'configured-model'),
      (error: unknown) => error instanceof AIRuntimeError && error.code === 'TIMEOUT');
    assert.equal(observedSignal?.aborted, true);
  });

  it('rejects invalid JSON', async () => {
    await assert.rejects(mockAdapter(response('{bad')).generateObject(objectRequest, 'configured-model'), (error: unknown) => error instanceof AIRuntimeError && error.code === 'INVALID_JSON');
  });

  it('rejects schema mismatch', async () => {
    await assert.rejects(mockAdapter(response('{"wrong":1}')).generateObject(objectRequest, 'configured-model'), (error: unknown) => error instanceof AIRuntimeError && error.code === 'SCHEMA_MISMATCH');
  });

  it('rejects refusal and empty output', async () => {
    await assert.rejects(mockAdapter(response('', [{ type: 'refusal', refusal: 'no' }])).generateObject(objectRequest, 'configured-model'), (error: unknown) => error instanceof AIRuntimeError && error.code === 'REFUSAL');
    await assert.rejects(mockAdapter(response('')).generateObject(objectRequest, 'configured-model'), (error: unknown) => error instanceof AIRuntimeError && error.code === 'EMPTY_RESPONSE');
  });
});

describe('OpenAI vision request', () => {
  it('constructs a Responses API data URL without exposing a key', () => {
    const request: VisionRequest = { scene: 'test.vision', capability: 'vision', prompt: 'inspect', image: { mediaType: 'image/png', base64: 'aGVsbG8=', detail: 'high' } };
    const input = buildOpenAIVisionInput(request);
    const content = (input[0] as { content: Array<{ type: string; image_url?: string; detail?: string }> }).content;
    assert.equal(content[1].type, 'input_image');
    assert.equal(content[1].image_url, 'data:image/png;base64,aGVsbG8=');
    assert.equal(content[1].detail, 'high');
  });

  it('constructs image and PDF inputs using Responses API content parts', () => {
    const input = buildOpenAIObjectInput({
      ...objectRequest,
      image: { mediaType: 'image/jpeg', base64: 'aW1hZ2U=' },
      file: { filename: 'safe-test.pdf', mediaType: 'application/pdf', base64: 'cGRm' },
    });
    const content = (input[0] as { content: Array<Record<string, unknown>> }).content;
    assert.deepEqual(content.map(item => item.type), ['input_text', 'input_image', 'input_file']);
    assert.equal(content[1].image_url, 'data:image/jpeg;base64,aW1hZ2U=');
    assert.equal(content[2].file_data, 'data:application/pdf;base64,cGRm');
    assert.equal(content[2].filename, 'safe-test.pdf');
  });
});
