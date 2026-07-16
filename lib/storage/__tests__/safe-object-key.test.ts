import assert from 'node:assert/strict';
import test from 'node:test';
import { techConfirmObjectKey } from '../safe-object-key';

const id = '59079fd3-059d-468d-9669-8445acfc8dd';
const uuid = '11111111-2222-4333-8444-555555555555';

for (const name of ['微信图片 2026.jpg', '确认单 (最终).PNG', 'same.pdf', 'same.pdf']) {
  test(`safe key for ${name}`, () => {
    const key = techConfirmObjectKey(id, name, uuid);
    assert.match(key, /^[a-zA-Z0-9_-]+\/tech-confirm\/[0-9a-f-]+\.(jpg|png|pdf)$/);
    assert.ok(!key.includes(name));
  });
}

test('different UUIDs prevent duplicate-name collisions', () => {
  assert.notEqual(techConfirmObjectKey(id, '同名.jpg', uuid), techConfirmObjectKey(id, '同名.jpg', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
});

test('rejects dangerous extension and path traversal', () => {
  assert.throws(() => techConfirmObjectKey(id, 'virus.exe', uuid), /UNSUPPORTED/);
  assert.throws(() => techConfirmObjectKey(id, '../confirm.jpg', uuid), /INVALID_FILE_NAME/);
});
