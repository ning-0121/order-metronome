import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parseSizeChartWorkbook } from '../size-chart';

test('parses the deterministic YT-0707 size chart layout', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('大货尺寸表');
  sheet.addRow(['YT-0707 S1567 大货尺寸表 26.7.4']);
  sheet.addRow(['测量部位', 'S', 'M', 'L']);
  sheet.addRow(['胸围', 90, 94, 98]);
  sheet.addRow(['衣长', 62.5, 64, 65.5]);
  const bytes = await book.xlsx.writeBuffer();
  const parsed = await parseSizeChartWorkbook(bytes as ArrayBuffer);
  assert.deepEqual(parsed.sizes, ['S', 'M', 'L']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].values.M, 94);
});

test('reports actionable error for unsupported layout', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Sheet1').addRow(['nothing useful']);
  await assert.rejects(() => book.xlsx.writeBuffer().then(b => parseSizeChartWorkbook(b as ArrayBuffer)), /未找到/);
});
