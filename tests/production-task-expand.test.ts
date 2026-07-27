import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildProductionTaskWorkbook, finalizeProductionTaskSheetNames } from '@/lib/exports/production-task-template';

const numToCol = (n: number) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
// 旧单母版(LU21-SET)会残留的关键词,用于断言"零串味"
const SAMPLE = /LU21|年年旺|1022832|瑜伽|仿锦|BLACK|GLOSS|海军蓝|岩木|云舞|上衣部位|长裤部位/;

const mk = (nColors: number, sizeList: string[]) => ({
  internalOrderNumber: 'T-001', customer: '客A', orderDate: '2026-07-24', productName: '测试款',
  materialComposition: '88%涤12%氨', deliveryDate: '2026-08-30', fabricWeight: '240g', totalQuantity: nColors * 100,
  styleNumber: 'TST', quantityBasis: 'piece' as const, sizeOrder: sizeList, customerPackaging: '每套一袋',
  colors: Array.from({ length: nColors }, (_, i) => ({
    styleNumber: 'TST', colorEn: `C${i}`, colorCn: `色${i}`, cartonCount: i + 1, quantity: 100,
    sizes: Object.fromEntries(sizeList.map((s, j) => [s, (i + 1) * (j + 1)])),
  })),
  fabrics: [{ name: '直贡呢', consumption: 0.3, unit: 'kg' }],
  requirements: { cutting: '同向裁', sewing: '线迹平整' }, sizeChart: null,
});

async function buildMain(nColors: number, sizeList: string[]) {
  const wb = await buildProductionTaskWorkbook(mk(nColors, sizeList) as any);
  const buf = await wb.xlsx.writeBuffer();
  const rb = new ExcelJS.Workbook(); await rb.xlsx.load(buf as any);
  const ws = rb.worksheets[0];
  const val = (a: string) => {
    let v: any = ws.getCell(a).value;
    if (v && typeof v === 'object') { if (v.richText) v = v.richText.map((t: any) => t.text).join(''); else if (v.result !== undefined) v = v.result; else v = JSON.stringify(v); }
    return v == null ? '' : String(v);
  };
  const leaks: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row: any) => row.eachCell({ includeEmpty: false }, (cell: any) => {
    let v: any = cell.value; if (v && typeof v === 'object') { if (v.richText) v = v.richText.map((t: any) => t.text).join(''); else v = JSON.stringify(v); }
    if (v && SAMPLE.test(String(v))) leaks.push(`${cell.address}=${String(v).slice(0, 16)}`);
  }));
  return { val, leaks };
}

describe('生产任务单主表动态扩展(#4)', () => {
  it('基线 2色×3码:表头 S/M/L、颜色行齐、无旧单残留', async () => {
    const { val, leaks } = await buildMain(2, ['S', 'M', 'L']);
    expect(['E6', 'F6', 'G6'].map(val)).toEqual(['S', 'M', 'L']);
    expect(val('B7')).toContain('色0');
    expect(val('B8')).toContain('色1');
    expect(val('G8')).toBe('6');           // 第2色第3码 = 2*3
    expect(val('A11')).toBe('总计');       // 总计未位移
    expect(leaks).toEqual([]);
  });

  it('双扩展 5色×5码:插2列插1行,全码全色齐、位移正确、零残留', async () => {
    const sizes = ['XS', 'S', 'M', 'L', 'XL'];
    const { val, leaks } = await buildMain(5, sizes);
    // 5 个尺码表头都在(E..I)
    expect(sizes.map((_, i) => val(`${numToCol(5 + i)}6`))).toEqual(sizes);
    // 5 个颜色行都在(7..11)
    expect(Array.from({ length: 5 }, (_, i) => val(`B${7 + i}`).includes(`色${i}`))).toEqual([true, true, true, true, true]);
    expect(val('I11')).toBe('25');         // 末色末码 = 5*5,列 I(5+4)
    expect(val('A12')).toBe('总计');            // 总计下移 1(11→12)
    expect(val('A19')).toContain('裁剪要求');   // 裁剪要求下移 1(18→19)
    expect(val('B19')).toBe('同向裁');
    expect(val('A26')).toContain('签收人');     // 签收下移 1(25→26)
    expect(val(`${numToCol(10)}6`)).toBe('客户包装'); // 客户包装右移 2(H→J)
    expect(leaks).toEqual([]);
  });

  it('仅扩列 1色×6码:6个尺码表头齐、零残留', async () => {
    const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
    const { val, leaks } = await buildMain(1, sizes);
    expect(sizes.map((_, i) => val(`${numToCol(5 + i)}6`))).toEqual(sizes);
    expect(val('J7')).toBe('6');           // 第1色第6码 = 1*6,列 J(5+5)
    expect(leaks).toEqual([]);
  });

  it('仅扩行 6色×3码:6个颜色行齐、总计下移2、零残留', async () => {
    const { val, leaks } = await buildMain(6, ['S', 'M', 'L']);
    expect(Array.from({ length: 6 }, (_, i) => val(`B${7 + i}`).includes(`色${i}`)).every(Boolean)).toBe(true);
    expect(val('A13')).toBe('总计');       // 总计下移 2(11→13)
    expect(leaks).toEqual([]);
  });

  // 母版串味修复(2026-07-27):sheet 标签名 + 主表嵌图 都不能带 LU21-SET 残留
  it('零串味:主表无嵌图(母版粉色套装产品图已清)', async () => {
    const wb = await buildProductionTaskWorkbook(mk(2, ['S', 'M', 'L']) as any);
    // buildProductionTaskWorkbook 内已清主表嵌图
    expect(wb.worksheets[0].getImages().length).toBe(0);
    // 写出再读回,确认持久
    const rb = new ExcelJS.Workbook(); await rb.xlsx.load((await wb.xlsx.writeBuffer()) as any);
    expect(rb.worksheets[0].getImages().length).toBe(0);
  });

  it('零串味:finalize 后 sheet 标签名去 LU21、为通用名', async () => {
    const wb = await buildProductionTaskWorkbook(mk(2, ['S', 'M', 'L']) as any);
    finalizeProductionTaskSheetNames(wb);
    const rb = new ExcelJS.Workbook(); await rb.xlsx.load((await wb.xlsx.writeBuffer()) as any);
    const names = rb.worksheets.map(w => w.name);
    expect(names.some(n => SAMPLE.test(n))).toBe(false);   // 无 LU21 等旧单关键词
    expect(names[0]).toBe('生产任务单');
    expect(names[1]).toBe('尺寸表');
  });
});
