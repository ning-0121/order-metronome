import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCustomerPoVersions } from '../customer-po-version';

test('deriveCustomerPoVersions keeps one active version and preserves history', () => {
  const versions = deriveCustomerPoVersions(
    [
      { id: 'a1', order_id: 'o1', file_type: 'customer_po', file_name: 'v1.pdf', uploaded_by: 'u1', created_at: '2026-07-01T10:00:00Z' },
      { id: 'a2', order_id: 'o1', file_type: 'customer_po', file_name: 'v2.pdf', uploaded_by: 'u2', created_at: '2026-07-02T10:00:00Z' },
      { id: 'a3', order_id: 'o1', file_type: 'customer_po', file_name: 'v3.pdf', uploaded_by: 'u3', created_at: '2026-07-03T10:00:00Z' },
    ],
    [
      {
        action: 'customer_po_replaced',
        note: '客户更新',
        payload: JSON.stringify({ from_attachment_id: 'a1', to_attachment_id: 'a2', reason: '客户更新' }),
        created_at: '2026-07-02T11:00:00Z',
      },
      {
        action: 'customer_po_replaced',
        note: '客户二次更新',
        payload: JSON.stringify({ from_attachment_id: 'a2', to_attachment_id: 'a3', reason: '客户二次更新' }),
        created_at: '2026-07-03T11:00:00Z',
      },
    ],
  );

  assert.equal(versions.versions.length, 3);
  assert.equal(versions.activeVersion?.id, 'a3');
  assert.equal(versions.versions[0].status, 'superseded');
  assert.equal(versions.versions[1].status, 'superseded');
  assert.equal(versions.versions[2].status, 'active');
  assert.equal(versions.versions[2].replacement_reason, '客户二次更新');
});

test('deriveCustomerPoVersions marks withdrawn version and keeps prior active', () => {
  const versions = deriveCustomerPoVersions(
    [
      { id: 'a1', order_id: 'o1', file_type: 'customer_po', file_name: 'v1.pdf', created_at: '2026-07-01T10:00:00Z' },
      { id: 'a2', order_id: 'o1', file_type: 'customer_po', file_name: 'v2.pdf', created_at: '2026-07-02T10:00:00Z' },
    ],
    [
      {
        action: 'customer_po_replaced',
        note: 'replace',
        payload: JSON.stringify({ from_attachment_id: 'a1', to_attachment_id: 'a2', reason: 'replace' }),
        created_at: '2026-07-02T11:00:00Z',
      },
      {
        action: 'customer_po_withdrawn',
        note: '撤回错误上传',
        payload: JSON.stringify({ attachment_id: 'a2', reason: '撤回错误上传' }),
        created_at: '2026-07-03T10:00:00Z',
      },
    ],
  );

  assert.equal(versions.versions[1].status, 'withdrawn');
  assert.equal(versions.versions[1].withdrawn_reason, '撤回错误上传');
});
