import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseAuxPaymentLedger, parsePayeeLine } from '@/lib/services/aux-payment-ledger-parser';

// 辅料付款对账单解析器(制袋/绣花等)—— 复用面料台账结构。
describe('parsePayeeLine 供应商/类别抽取', () => {
  it('付款事由:2026年3-6月龙杰制袋对账单 → 龙杰 / 制袋', () => {
    const r = parsePayeeLine('付款事由：2026年3-6月龙杰制袋对账单');
    expect(r.supplier).toBe('龙杰');
    expect(r.category).toBe('制袋');
  });
  it('无类别后缀 → category null,supplier 保留', () => {
    const r = parsePayeeLine('付款事由：2026年5月旺泽货款');
    expect(r.supplier).toBe('旺泽');
    expect(r.category).toBeNull();
  });
});

function buildAuxBuffer(rows: any[][], sheetName = '3-6月'): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('parseAuxPaymentLedger', () => {
  const rows = [
    ['义乌市绮陌服饰有限公司'],
    ['付款事由：2026年3-6月龙杰制袋对账单'],
    ['序号', '摘要', '金额', '客户', '月份'],
    ['1', '1022801', '1109.00', '巴拿马', '3月'],
    ['2', '1022817', '3053.00', '巴拿马', '3月'],
    ['3', '3301961', '3465.00', 'S2', '3月'],
    ['', '合计', '7627.00', '', ''],
  ];

  it('解析出 3 行(合计/空行跳过),供应商=龙杰,金额入 amountExTax', () => {
    const r = parseAuxPaymentLedger(buildAuxBuffer(rows));
    expect(r.rows.length).toBe(3);
    expect(r.rows[0].supplierNameRaw).toBe('龙杰');
    expect(r.rows[0].orderNoRaw).toBe('1022801');
    expect(r.rows[0].internalOrderNo).toBe('1022801');
    expect(r.rows[0].amountExTax).toBe(1109);
    expect(r.rows[0].customerName).toBe('巴拿马');
    expect(r.rows[0].fabricName).toBe('制袋');   // 辅料类别标注
    expect(r.totalAmount).toBe(1109 + 3053 + 3465);
  });

  it('supplierOverride 优先于付款事由', () => {
    const r = parseAuxPaymentLedger(buildAuxBuffer(rows), '龙杰制袋厂');
    expect(r.rows[0].supplierNameRaw).toBe('龙杰制袋厂');
  });

  it('无摘要/金额表头 → 0 行(不误判)', () => {
    const bad = buildAuxBuffer([['随便'], ['一些', '别的', '列']]);
    expect(parseAuxPaymentLedger(bad).rows.length).toBe(0);
  });
});
