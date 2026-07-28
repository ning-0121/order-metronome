import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseFabricLedger } from '@/lib/services/fabric-ledger-parser';

// 2026-07-27 bug 回归:源表底部「开票金额(10%)/合计」这类税/发票汇总行落在订单号列、带金额,
// 之前被当明细行计入应付 → 税点金额重复算进需支付。解析器现在必须跳过它们。
function buildBuffer(rows: unknown[][], sheetName = '兰氏'): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const HEADER = ['订单号', '面料', '颜色', '采购数量(KG)', '实到数量(KG)', '差', '单价(不含税)', '金额(不含税)', '发票', '备注', '客户'];

describe('parseFabricLedger — 税/发票汇总行不计入', () => {
  it('跳过「开票金额(10%)」和「合计」行,只算真实明细', () => {
    const buf = buildBuffer([
      ['兰氏面料采购明细表汇总'],
      HEADER,
      ['1022863', '包装', '', '', '', '', '', 743.85, '7月', '', 'EHL'],
      ['1022864', '包装', '', '', '', '', '', 2000, '7月', '', 'EHL'],
      ['开票金额（10%）', '包装', '', '', '', '', '', 28774.9, '', '', ''],   // 税汇总 → 必须跳过
      ['合计', '', '', '', '', '', '', 54933.9, '', '', ''],                  // 合计 → 必须跳过
    ]);
    const res = parseFabricLedger(buf);

    // 只有 2 条真实明细
    expect(res.rows).toHaveLength(2);
    // 金额合计 = 743.85 + 2000,绝不含 28774.9(税)或 54933.9(合计)
    expect(res.totalAmount).toBeCloseTo(2743.85, 2);
    expect(res.rows.some((r) => r.amountExTax === 28774.9)).toBe(false);
    expect(res.rows.some((r) => r.orderNoRaw.includes('开票'))).toBe(false);
    expect(res.rows.map((r) => r.orderNoRaw)).toEqual(['1022863', '1022864']);
    // 内部单号抽取正常
    expect(res.rows[0].internalOrderNo).toBe('1022863');
  });

  it('也跳过「税额/税金/税费」这类别名汇总行', () => {
    const buf = buildBuffer([
      HEADER,
      ['1022900', '主标', '', '', '', '', '', 100, '', '', 'RAG'],
      ['税额', '', '', '', '', '', '', 13, '', '', ''],
    ]);
    const res = parseFabricLedger(buf);
    expect(res.rows).toHaveLength(1);
    expect(res.totalAmount).toBeCloseTo(100, 2);
  });
});
