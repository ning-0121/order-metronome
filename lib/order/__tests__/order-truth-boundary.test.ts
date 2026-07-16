import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('Order truth boundaries', () => {
  it('does not use the AI snapshot in production sheet generation', async () => {
    const source = await readFile('app/actions/manufacturing-order.ts', 'utf8');
    assert.doesNotMatch(source, /po_parse_snapshot/);
  });

  it('keeps the frozen snapshot immutable', async () => {
    const source = await readFile('app/actions/order-line-items.ts', 'utf8');
    const refreezeBody = source.slice(source.indexOf('export async function refreezePoParseSnapshot'), source.indexOf('/** 读订单明细'));
    assert.doesNotMatch(refreezeBody, /\.update\s*\(/);
    assert.match(refreezeBody, /不能覆盖/);
  });

  it('deduplicates recognition by content checksum', async () => {
    const source = await readFile('app/actions/po-parser.ts', 'utf8');
    assert.match(source, /createHash\('sha256'\)/);
    assert.match(source, /checksumSha256/);
  });
});
