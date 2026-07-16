import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { buildProductionTaskWorkbook, loadProductionTaskTemplate, safeProductionTaskFilename } from '../lib/exports/production-task-template';
import { productionTaskFixedTextManifest, productionTaskStyleManifest } from '../lib/exports/production-task-style-manifest';
import { PRODUCTION_TASK_SHEETS } from '../lib/exports/production-task-template-map';

const fixture = {
  internalOrderNumber: 'QM-1001', customer: '年年旺', orderDate: '2026-07-16', productName: '瑜伽套装', materialComposition: '锦纶/氨纶',
  deliveryDate: '2026-08-20', fabricWeight: '280gsm', totalQuantity: 2400, styleNumber: 'LU21-SET', quantityBasis: 'set' as const,
  sizeOrder: ['S', 'M', 'L'], customerPackaging: '一套一袋，30套一箱',
  colors: ['黑色', '海军蓝', '岩木色', '云舞白'].map((color, i) => ({ color, cartonCount: 10 + i, quantity: 600, sizes: { S: 200, M: 200, L: 200 } })),
  fabrics: [{ name: '280克直贡呢', consumption: 0.317, unit: '公斤/套', basis: '每套' }],
  requirements: { garmentAccessories: '主唛', packagingAccessories: '吊牌、OPP袋', cutting: '同向裁剪', sewing: '线迹平整',
    inspection: '尺寸在公差范围', packaging: '吊牌朝外', carton: '30套一箱', attention: '不可少出或晚交' },
  sizeChart: { top: [{ sequence: 'A', position: '衣长', values: { S: 20, M: 21, L: 22 } }], bottom: [{ position: '腰围', values: { S: 12, M: 13, L: 14 } }] },
};

async function main() {
  const master = await loadProductionTaskTemplate();
  assert.deepEqual(master.worksheets.map(s => s.name), [PRODUCTION_TASK_SHEETS.main, PRODUCTION_TASK_SHEETS.size]);
  const exported = await buildProductionTaskWorkbook(fixture);
  assert.deepEqual(productionTaskStyleManifest(exported), productionTaskStyleManifest(master), 'non-business styles/layout changed');
  assert.deepEqual(productionTaskFixedTextManifest(exported), productionTaskFixedTextManifest(master), 'fixed text changed');
  const mainSheet = exported.getWorksheet(PRODUCTION_TASK_SHEETS.main)!;
  assert.equal(mainSheet.getCell('D2').value, 'QM-1001（年年旺）'); assert.equal(mainSheet.getCell('D5').value, 2400);
  assert.equal(mainSheet.getCell('A12').value, '280克直贡呢 0.317 公斤/套 (每套)');
  assert.equal(mainSheet.pageSetup.orientation, 'portrait'); assert.equal(mainSheet.pageSetup.paperSize, 9); assert.equal(mainSheet.pageSetup.scale, 50);
  const sizeSheet = exported.getWorksheet(PRODUCTION_TASK_SHEETS.size)!;
  assert.equal(sizeSheet.pageSetup.orientation, 'landscape'); assert.equal(sizeSheet.pageSetup.scale, 90);
  const second = await buildProductionTaskWorkbook(fixture);
  assert.deepEqual(productionTaskStyleManifest(second), productionTaskStyleManifest(exported), 'repeated export style manifest changed');
  const overflow = await buildProductionTaskWorkbook({ ...fixture, sizeOrder: ['XS', 'S', 'M', 'L'], colors: [...fixture.colors, { color: '红色', quantity: 1, sizes: { XS: 1 } }] });
  assert.equal(overflow.worksheets.length, 3); assert.equal(overflow.worksheets[0].name, PRODUCTION_TASK_SHEETS.main);
  const visualFixtures = [
    fixture,
    { ...fixture, productName: '两件套', quantityBasis: 'set' as const },
    { ...fixture, colors: [...fixture.colors, { color: '红色', quantity: 12, sizes: { S: 4, M: 4, L: 4 } }] },
    { ...fixture, sizeOrder: ['XS', 'S', 'M', 'L', 'XL'] },
    { ...fixture, customerPackaging: '', fabricWeight: '', requirements: {} },
    { ...fixture, customerPackaging: '中文长包装说明：'.repeat(30) },
  ];
  for (const visualFixture of visualFixtures) {
    const visual = await buildProductionTaskWorkbook(visualFixture);
    assert.equal(visual.worksheets[0].name, PRODUCTION_TASK_SHEETS.main);
    assert.deepEqual(productionTaskStyleManifest(visual)[0], productionTaskStyleManifest(master)[0]);
  }
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'qimo-template-missing-'));
  await assert.rejects(loadProductionTaskTemplate(missingRoot), /母版缺失/);
  assert.equal(safeProductionTaskFilename('QM/1001', 'A:*?'), 'QM_1001_生产任务单_A___.xlsx');
  const bytes = await exported.xlsx.writeBuffer();
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), 'qimo-template-output-')), 'fixture.xlsx');
  await writeFile(output, Buffer.from(bytes));
  const reopened = new ExcelJS.Workbook(); await reopened.xlsx.readFile(output);
  assert.deepEqual(reopened.worksheets.map(s => s.name), exported.worksheets.map(s => s.name), 'workbook re-open failed');
  console.log('production task template: 18 assertions passed');
}

main().catch(error => { console.error(error); process.exit(1); });
