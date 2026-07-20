import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { parseSizeChartWorkbook } from '../size-chart.ts';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs') as typeof import('exceljs');

async function parseWorkbook(build: (book: ExcelJS.Workbook) => void, options?: Parameters<typeof parseSizeChartWorkbook>[1]) {
  const book = new ExcelJS.Workbook();
  build(book);
  const bytes = await book.xlsx.writeBuffer();
  return parseSizeChartWorkbook(bytes as ArrayBuffer, options);
}

test('parses a standard horizontal Chinese size chart', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('大货尺寸表');
    sheet.addRow(['说明', '示例']);
    sheet.addRow(['测量部位', 'S', 'M', 'L']);
    sheet.addRow(['胸围', 90, 94, 98]);
    sheet.addRow(['衣长', 62.5, 64, 65.5]);
  });

  assert.equal(parsed.status, 'PARSED');
  assert.equal(parsed.orientation, 'horizontal');
  assert.equal(parsed.worksheetName, '大货尺寸表');
  assert.deepEqual(parsed.sizeLabels, ['S', 'M', 'L']);
  assert.deepEqual(parsed.measurementLabels, ['胸围', '衣长']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].values.M, 94);
  assert.equal(parsed.confidence >= 80, true);
});

test('parses a standard vertical Chinese size chart', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('版型表');
    sheet.addRow(['尺码', '胸围', '衣长']);
    sheet.addRow(['S', 90, 62.5]);
    sheet.addRow(['M', 94, 64]);
    sheet.addRow(['L', 98, 65.5]);
  });

  assert.equal(parsed.status, 'PARSED');
  assert.equal(parsed.orientation, 'vertical');
  assert.deepEqual(parsed.sizeLabels, ['S', 'M', 'L']);
  assert.deepEqual(parsed.measurementLabels, ['胸围', '衣长']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].values.L, 65.5);
});

test('supports english headers and workbook offset rows', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('OffsetSheet');
    sheet.addRow(['Title line']);
    sheet.addRow(['Note line']);
    sheet.addRow([]);
    sheet.addRow(['Measurement', 'XS', 'S', 'M']);
    sheet.addRow(['Bust', 88, 92, 96]);
    sheet.addRow(['Length', 58, 60, 62]);
  });

  assert.equal(parsed.status, 'PARSED');
  assert.equal(parsed.orientation, 'horizontal');
  assert.deepEqual(parsed.sizeLabels, ['XS', 'S', 'M']);
  assert.deepEqual(parsed.measurementLabels, ['Bust', 'Length']);
  assert.equal(parsed.rows[0].values.XS, 88);
});

test('supports merged/range style size headers with sequential expansion', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('MergedRange');
    sheet.addRow(['']);
    sheet.addRow(['测量部位', 'XS-XL']);
    sheet.addRow(['胸围', 88, 92, 96, 100, 104, 108]);
    sheet.addRow(['衣长', 58, 60, 62, 64, 66, 68]);
  });

  assert.equal(parsed.status, 'PARSED');
  assert.equal(parsed.orientation, 'horizontal');
  assert.deepEqual(parsed.sizeLabels, ['XS', 'S', 'M', 'L', 'XL']);
  assert.equal(parsed.rows[0].values.XL, 104);
});

test('supports multiple sheets and selects the sheet with a recognisable table', async () => {
  const parsed = await parseWorkbook((book) => {
    const a = book.addWorksheet('Cover');
    a.addRow(['nothing useful']);
    const b = book.addWorksheet('尺码表');
    b.addRow(['测量部位', 'S', 'M', 'L']);
    b.addRow(['胸围', 90, 94, 98]);
    b.addRow(['衣长', 62, 64, 66]);
  });

  assert.equal(parsed.status, 'PARSED');
  assert.equal(parsed.worksheetName, '尺码表');
  assert.equal(parsed.rows.length, 2);
});

test('returns actionable diagnostics when size columns are missing', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('BadLayout');
    sheet.addRow(['测量部位', '备注']);
    sheet.addRow(['胸围', '仅供参考']);
  });

  assert.equal(parsed.status, 'FAILED');
  assert.ok(parsed.errors.includes('NO_RECOGNIZABLE_TABLE'));
  assert.ok(parsed.diagnostics.some((d) => d.message.includes('尺码列')));
});

test('returns actionable diagnostics when measurement columns are missing', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('BadVertical');
    sheet.addRow(['尺码', 'A', 'B']);
    sheet.addRow(['S', 1, 2]);
  });

  assert.equal(parsed.status, 'FAILED');
  assert.ok(parsed.errors.includes('NO_RECOGNIZABLE_TABLE'));
  assert.ok(parsed.diagnostics.some((d) => d.message.includes('测量部位列')));
});

test('manual hints can reopen an offset sheet', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('Hinted');
    sheet.addRow(['noise']);
    sheet.addRow(['noise']);
    sheet.addRow(['Measurement', 'S', 'M']);
    sheet.addRow(['Bust', 90, 94]);
    sheet.addRow(['Length', 58, 60]);
  }, { worksheetName: 'Hinted', headerRow: 3, orientation: 'horizontal' });

  assert.equal(parsed.status, 'PARSED');
  assert.equal(parsed.headerRow, 3);
  assert.equal(parsed.orientation, 'horizontal');
});

test('returns NEEDS_REVIEW for ambiguous multiple candidate tables', async () => {
  const parsed = await parseWorkbook((book) => {
    const a = book.addWorksheet('SheetA');
    a.addRow(['测量部位', 'S', 'M']);
    a.addRow(['胸围', 90, 94]);
    const b = book.addWorksheet('SheetB');
    b.addRow(['尺码', '胸围', '衣长']);
    b.addRow(['S', 90, 62]);
    b.addRow(['M', 94, 64]);
  });

  assert.equal(parsed.status, 'NEEDS_REVIEW');
  assert.ok(parsed.warnings.some((w) => w.includes('多个候选表')));
});

test('reports a workbook-level failure when no table exists', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('Empty');
    sheet.addRow(['hello world']);
  });

  assert.equal(parsed.status, 'FAILED');
  assert.ok(parsed.errors.includes('NO_RECOGNIZABLE_TABLE'));
});

test('parses the anonymized real workbook structure with combined 部位/尺码 header and formula results', async () => {
  const parsed = await parseWorkbook((book) => {
    const sheet = book.addWorksheet('Sheet1');
    sheet.mergeCells('A1:G1'); sheet.getCell('A1').value = '匿名款式尺寸表';
    sheet.addRow(['部位/尺码', 'XS', 'S', 'M', 'L', 'XL', '跳码']);
    sheet.addRow(['松紧围', { formula: 'C3-G3', result: 28.5 }, { formula: 'D3-G3', result: 31 }, 33.5, { formula: 'D3+G3', result: 36 }, { formula: 'E3+G3', result: 38.5 }, 2.5]);
    for (const row of [
      ['半臀围', 35.5, 38, 40.5, 43, 45.5, 2.5], ['前浪含腰', 23.5, 24.5, 25.5, 26.5, 27.5, 1],
      ['后浪含腰', 36, 37, 38, 39, 40, 1], ['膝围', 17.5, 18.5, 19.5, 20.5, 21.5, 1],
      ['脚口', 22.5, 23, 23.5, 24, 24.5, 0.5], ['腰头高', 9, 9, 9, 9, 9, 0],
      ['腿肥', 21.75, 23, 24.25, 25.5, 26.75, 1.25], ['内长', 77.5, 78, 78.5, 79, 79.5, 0.5],
      ['三角裆尺寸', '4.4*5.2', '4.4*5.2', '4.4*5.2', '4.4*5.2', '4.4*5.2', 0],
    ]) sheet.addRow(row);
    book.addWorksheet('Sheet2'); book.addWorksheet('Sheet3');
  });
  assert.equal(parsed.status, 'PARSED'); assert.equal(parsed.worksheetName, 'Sheet1');
  assert.equal(parsed.orientation, 'horizontal'); assert.equal(parsed.headerRow, 2);
  assert.deepEqual(parsed.sizeLabels, ['XS', 'S', 'M', 'L', 'XL']); assert.equal(parsed.rows.length, 10);
  assert.equal(parsed.rows[0].values.XS, 28.5); assert.deepEqual(parsed.errors, []);
});
