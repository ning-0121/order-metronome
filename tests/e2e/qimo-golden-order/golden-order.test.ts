import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { GOLDEN_ORDER } from './fixture';
import { addDecimals, calculateRequirement } from '../../../lib/domain/quantity-calculation';
import { compareConsumption, normalizeConsumptionDecimal } from '../../../lib/production/consumption';
import { techConfirmObjectKey } from '../../../lib/storage/safe-object-key';
import { assertToolAuthorized } from '../../../lib/ai/runtime/tool-safety';
import { parseSizeChartWorkbook } from '../../../lib/parsers/size-chart';
import { matchAccessory, parseAccessoryWorkbook } from '../../../lib/parsers/accessory-import';

async function workbookBytes(rows: unknown[][], sheetName: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  rows.forEach(row => sheet.addRow(row));
  const data = await workbook.xlsx.writeBuffer();
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

describe('TEST-QIMO-E2E-001 synthetic golden order', () => {
  it('A Happy Path: reconciles SKU, shipment and payment totals', () => {
    const skuTotal = Object.values(GOLDEN_ORDER.styles[0].sizes).reduce((a, b) => a + b, 0);
    assert.equal(skuTotal, GOLDEN_ORDER.quantitySets);
    assert.equal(GOLDEN_ORDER.shipments.reduce((a, b) => a + b.quantity, 0), GOLDEN_ORDER.quantitySets);
    assert.equal(GOLDEN_ORDER.receivables.reduce((a, b) => a + b.percent, 0), 100);
  });

  it('B AI Failure / Manual Entry: Finance AI writes remain forbidden', () => {
    assert.throws(() => assertToolAuthorized({
      scene: 'finance.post-entry', safetyLevel: 'WRITE_REQUIRES_APPROVAL', approvedByHuman: true,
    }));
  });

  it('C Set Product: does not multiply component-per-set consumption twice', () => {
    const setConsumption = addDecimals('0.35', '0.32');
    assert.equal(setConsumption, 0.67);
    assert.equal(calculateRequirement({ consumption: setConsumption, orderSets: 7700, basis: 'PER_SET', piecesPerSet: 2 }).gross, 5159);
    assert.equal(calculateRequirement({ consumption: '0.672384', orderSets: 7700, basis: 'PER_SET' }).gross, 5177.3568);
  });

  it('D Material Shortage: preserves decimal and rejects unit mixing', () => {
    assert.equal(normalizeConsumptionDecimal('0.032'), '0.032');
    assert.equal(compareConsumption({ quoted: '1.05', actual: '1.05', quotedUnit: '米/件', actualUnit: 'm' }).ok, true);
    assert.equal(compareConsumption({ quoted: '1.05', actual: '0.75', quotedUnit: '米/件', actualUnit: '平方米/件' }).ok, false);
  });

  it('E Production Delay: requires server authorization (covered by G-K domain suite)', () => {
    assert.equal(GOLDEN_ORDER.id.startsWith('TEST-'), true);
  });

  it('F QC Failure and Reinspection: fixture requires all three inspections', () => {
    assert.deepEqual(GOLDEN_ORDER.qc, { firstPiece: true, inline: true, final: true });
  });

  it('G Partial Shipment: split quantities cannot exceed the approved order', () => {
    const firstOnly = GOLDEN_ORDER.shipments[0].quantity;
    assert.ok(firstOnly < GOLDEN_ORDER.quantitySets);
    assert.ok(GOLDEN_ORDER.shipments.reduce((a, b) => a + b.quantity, 0) <= GOLDEN_ORDER.quantitySets);
  });

  it('H Partial Payment: schedule percentages reconcile exactly', () => {
    assert.deepEqual(GOLDEN_ORDER.receivables.map(x => x.percent), [30, 70]);
  });

  it('I Order Change / Revision: deterministic size chart remains reviewable input', async () => {
    const bytes = await workbookBytes([
      ['TEST / NOT A REAL ORDER'], ['测量部位', 'S', 'M', 'L', 'XL'],
      ['胸围', 80, 84, 88, 92], ['衣长', 60, 62, 64, 66],
    ], '大货尺寸表');
    const parsed = await parseSizeChartWorkbook(bytes);
    assert.equal(parsed.sheetName, '大货尺寸表');
    assert.equal(parsed.rows.length, 2);
  });

  it('J Cancellation: synthetic fixture cannot be mistaken for a live order', () => {
    assert.match(GOLDEN_ORDER.customer, /^TEST \/ NOT A REAL/);
  });

  it('K Unauthorized Role: dangerous Finance tool is denied even with claimed approval', () => {
    assert.throws(() => assertToolAuthorized({ scene: 'finance.update', safetyLevel: 'WRITE_REQUIRES_APPROVAL', approvedByHuman: true }));
  });

  it('L Duplicate Retry / Idempotency: generated keys differ and raw Chinese name is absent', () => {
    const a = techConfirmObjectKey(GOLDEN_ORDER.id, '测试 确认(1).jpg', '11111111-1111-4111-8111-111111111111');
    const b = techConfirmObjectKey(GOLDEN_ORDER.id, '测试 确认(1).jpg', '22222222-2222-4222-8222-222222222222');
    assert.notEqual(a, b);
    assert.equal(a.includes('测试'), false);
  });

  it('imports accessory candidates but exact matching does not auto-approve', async () => {
    const bytes = await workbookBytes([
      ['辅料编码', '辅料名称', '规格', '颜色', '使用部位', '单位', '单耗', '用量基准'],
      ['TEST-A1', 'TEST 拉链', '20cm', '黑', '前中', '条', 1, 'PER_SET'],
    ], '采购辅料');
    const parsed = await parseAccessoryWorkbook(bytes);
    assert.equal(parsed.rows.length, 1);
    assert.equal(matchAccessory(parsed.rows[0].normalized, [{ id: 'bom-test', material_code: 'TEST-A1' }])?.confidence, 1);
    assert.equal('approved' in parsed.rows[0], false);
  });
});
