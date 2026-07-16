import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  CREATE_ORDER_DRAFT_KEY, isStaleServerActionError, loadSafeOrderDraft, saveSafeOrderDraft,
  serializeSafeOrderDraft, STALE_SERVER_ACTION_MESSAGE,
} from '../lib/order/create-order-resilience';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const form = new FormData();
form.set('customer_id', 'customer-1'); form.set('customer_name', '测试客户'); form.set('internal_order_no', 'SAFE-001');
form.set('customer_po_file', new File(['secret'], 'customer-po.xlsx'));
form.set('po_parse_snapshot', '{"sensitive":true}');
assert.equal(isStaleServerActionError(new Error('Failed to find Server Action "abc"')), true);
assert.equal(isStaleServerActionError(new Error('database unavailable')), false);
assert.match(STALE_SERVER_ACTION_MESSAGE, /页面版本已过期/);
const serialized = serializeSafeOrderDraft(form);
assert.deepEqual(serialized.fields, [['customer_id', 'customer-1'], ['customer_name', '测试客户'], ['internal_order_no', 'SAFE-001']]);
const storage = new MemoryStorage(); saveSafeOrderDraft(form, storage as unknown as Storage);
assert.equal(storage.values.has(CREATE_ORDER_DRAFT_KEY), true);
assert.deepEqual(loadSafeOrderDraft(storage as unknown as Storage)?.fields, serialized.fields);
assert.doesNotMatch(storage.values.get(CREATE_ORDER_DRAFT_KEY) || '', /secret|customer-po|sensitive/);

const sw = readFileSync('public/sw.js', 'utf8');
assert.match(sw, /mode === 'navigate'/); assert.match(sw, /pathname\.startsWith\('\/_next\/'\)/);
assert.match(sw, /headers\.get\('RSC'\)/); assert.doesNotMatch(sw, /OFFLINE_URL/);
const component = readFileSync('components/order/LegacyOrderForm.tsx', 'utf8');
assert.match(component, /disabled=\{loading \|\| verifying/); assert.match(component, /isStaleServerActionError/);
assert.match(component, /if \(createSubmissionInFlight\.current\) return/);
const action = readFileSync('app/actions/orders.ts', 'utf8');
assert.match(action, /export async function createOrder/); assert.match(action, /\.eq\('order_no', preGeneratedOrderNo\)/);
assert.match(action, /created_by.*user\.id/); assert.match(action, /internal_order_no.*internal_order_no\.trim/);
const docs = readFileSync('docs/SERVER_ACTION_BUILD_SKEW_RUNBOOK.md', 'utf8');
assert.match(docs, /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
assert.doesNotMatch(docs, /NEXT_SERVER_ACTIONS_ENCRYPTION_KEY\s*=\s*[A-Za-z0-9+/]{20,}/);

const manifestPath = '.next/server/server-reference-manifest.json';
if (existsSync(manifestPath)) {
  const manifest = readFileSync(manifestPath, 'utf8');
  assert.match(manifest, /app\/actions\/orders/);
  assert.match(manifest, /createOrder/);
}
console.log('server action resilience: 20 assertions passed');
