import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  customerSelectionLabel, selectedCustomerFromDraft, toSelectedCustomer, writeSelectedCustomer,
} from '../lib/order/customer-selection';

const confirmed = { id: 'customer-yitong', name: '伊彤' };

assert.equal(toSelectedCustomer({ id: '', customer_name: '伊彤' }), null);
assert.equal(customerSelectionLabel(null, '伊彤'), 'AI识别客户：伊彤，待确认');
assert.deepEqual(toSelectedCustomer({ id: confirmed.id, customer_name: confirmed.name }), confirmed);

const manualOverridesAi = confirmed;
assert.equal(customerSelectionLabel(manualOverridesAi, '相似客户'), '已选择客户：伊彤');

const payload = new FormData();
assert.equal(writeSelectedCustomer(payload, confirmed), true);
assert.equal(payload.get('customer_id'), confirmed.id);
assert.equal(payload.get('customer_name'), confirmed.name);

assert.deepEqual(selectedCustomerFromDraft([['customer_id', confirmed.id], ['customer_name', confirmed.name]]), confirmed);
assert.equal(selectedCustomerFromDraft([['customer_name', confirmed.name]]), null);

const emptyPayload = new FormData(); emptyPayload.set('customer_name', '伊彤');
assert.equal(writeSelectedCustomer(emptyPayload, null), false);
assert.equal(emptyPayload.has('customer_name'), false);

const form = readFileSync('components/order/LegacyOrderForm.tsx', 'utf8');
assert.match(form, /const \[selectedCustomer, setSelectedCustomer\] = useState<SelectedCustomer>/);
assert.match(form, /writeSelectedCustomer\(rawFormData, selectedCustomer\)/);
assert.doesNotMatch(form, /fillIfEmpty\('customer_name'/);
assert.match(form, /onSelect=\{\(customer\) => setSelectedCustomer\(toSelectedCustomer/);
assert.match(form, /AI识别客户：/);

const selector = readFileSync('components/CustomerSelect.tsx', 'utf8');
assert.match(selector, /selectedValue\?: \{ id: string; name: string \} \| null/);
assert.match(selector, /name="customer_id" value=\{effectiveId\}/);
assert.match(selector, /name="customer_name" value=\{effectiveName\}/);

const draft = readFileSync('lib/order/create-order-resilience.ts', 'utf8');
assert.match(draft, /name === 'customer_id' \|\| name === 'customer_name'/);

const action = readFileSync('app/actions/orders.ts', 'utf8');
assert.match(action, /\.from\('customers'\)/);
assert.match(action, /\.eq\('id', customer_id\)/);
assert.match(action, /const customer_name = String\(selectedCustomerRecord\.customer_name\)/);
assert.ok(action.indexOf(".from('customers')") < action.indexOf('createOrderRepo(insertPayload'));

console.log('create-order customer selection: 24 assertions passed');
