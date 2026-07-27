/**
 * 辅料付款对账单解析器(2026-07-26)——零 token 代码解析。
 * 用途:把「制袋/绣花/印花」等辅料供应商的付款对账单导入供应商采购对账台账(复用 supplier_fabric_ledger)。
 *
 * 输入格式(用户实际文件,如「2026年3-6月龙杰制袋货款.xlsx」):
 *   一个工作簿,**一家供应商**;数据 sheet(如「3-6月」):
 *     r0 = 公司抬头 · r1 = 「付款事由:2026年3-6月龙杰制袋对账单」(供应商名在此)
 *     r? = 表头「序号 | 摘要 | 金额 | 客户 | 月份」
 *     数据行 = 序号 | 摘要(=内部订单号) | 金额 | 客户 | 月份
 *   其余 sheet(开票截图)无表格数据 → 跳过。
 *
 * 复用 FabricLedgerRow 结构落同一张台账:供应商=龙杰(付款事由/或调用方指定),订单=摘要,金额=金额(不含税,税率后设),
 *   fabricName 记辅料类别(如「制袋」),deliveryNote 记月份,customerName=客户。面料专属列(kg/单价)留空。
 */
import * as XLSX from 'xlsx';
import { type FabricLedgerRow, type FabricLedgerParseResult, extractInternalOrderNo } from './fabric-ledger-parser';

function s(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return `${v.getFullYear()}.${String(v.getMonth() + 1).padStart(2, '0')}.${String(v.getDate()).padStart(2, '0')}`;
  return String(v).trim();
}
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[,，\s¥￥]/g, '').replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 从付款事由抽供应商名 + 辅料类别:「付款事由:2026年3-6月龙杰制袋对账单」→ {supplier:'龙杰', category:'制袋'}。尽力而为。 */
export function parsePayeeLine(text: string): { supplier: string | null; category: string | null } {
  let t = s(text).replace(/^付款事由\s*[:：]?/,'').trim();
  t = t.replace(/^\d{4}年/, '').replace(/\d{1,2}([\-~至到]\d{1,2})?月/g, '').trim();  // 去年月
  t = t.replace(/(对账单|明细表?|汇总|货款|付款)$/g, '').trim();                        // 去尾巴
  if (!t) return { supplier: null, category: null };
  // 常见辅料类别后缀
  const catM = t.match(/(制袋|绣花|印花|洗水|电绣|烫画|包装|辅料|织唛|吊牌|拉链)$/);
  if (catM) return { supplier: t.slice(0, catM.index).trim() || t, category: catM[1] };
  return { supplier: t, category: null };
}

/** 定位表头行(含「摘要」和「金额」)→ 列索引。 */
function locate(rows: unknown[][]): { headerRow: number; col: Record<string, number> } | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r] || [];
    const joined = row.map(s).join('');
    if (!(joined.includes('摘要') && joined.includes('金额'))) continue;
    const col: Record<string, number> = {};
    row.forEach((cell, i) => {
      const t = s(cell);
      if (t.includes('摘要')) col.summary = i;
      else if (t.includes('金额')) col.amount = i;
      else if (t.includes('客户')) col.customer = i;
      else if (t.includes('月份') || t === '月') col.month = i;
      else if (t.includes('序号')) col.seq = i;
    });
    if (col.summary != null && col.amount != null) return { headerRow: r, col };
  }
  return null;
}

/**
 * 解析辅料付款对账单。supplierOverride 优先(UI 让用户确认/填供应商名)。
 * @param buffer xlsx 字节
 * @param supplierOverride 调用方指定供应商名(优先于付款事由解析)
 */
export function parseAuxPaymentLedger(buffer: Buffer, supplierOverride?: string): FabricLedgerParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const out: FabricLedgerRow[] = [];
  const warnings: string[] = [];
  let sheetCount = 0;
  let totalAmount = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' }) as unknown[][];
    if (!rows.length) continue;

    const loc = locate(rows);
    if (!loc) continue;   // 开票截图等无表格 sheet 直接跳过(不告警,属正常)
    const { headerRow, col } = loc;

    // 供应商 + 辅料类别:override 优先,否则扫「付款事由」行
    let supplier = (supplierOverride || '').trim();
    let category: string | null = null;
    for (let r = 0; r < headerRow; r++) {
      const line = (rows[r] || []).map(s).join('');
      if (line.includes('付款事由') || /对账单|货款/.test(line)) {
        const p = parsePayeeLine(line);
        if (!supplier && p.supplier) supplier = p.supplier;
        if (p.category) category = p.category;
        break;
      }
    }
    if (!supplier) { supplier = sheetName.trim() || '辅料供应商'; warnings.push('未能从付款事由识别供应商名,已用兜底名,请在台账里「关联供应商」更正。'); }

    let sheetHasData = false;
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const get = (k: string): unknown => (col[k] != null ? row[col[k]] : undefined);
      const summary = s(get('summary'));
      const amount = num(get('amount'));
      const customer = s(get('customer'));
      const month = s(get('month'));

      // 跳过合计/空行/重复表头
      if (/合计|小计|总计|总金额/.test(`${summary}${customer}`)) continue;
      if (summary === '摘要') continue;
      if (!summary && amount == null) continue;   // 纯空行

      out.push({
        supplierNameRaw: supplier,
        orderNoRaw: summary,
        internalOrderNo: extractInternalOrderNo(summary),
        fabricName: category || '辅料',    // 辅料类别(制袋/绣花…),台账里标明是什么费
        color: '',
        orderedKg: null, receivedKg: null, diffKg: null, unitPriceExTax: null,
        amountExTax: amount,               // 金额按不含税存,税率后设(与面料同口径)
        invoiceStatus: '',
        deliveryNote: month ? `${month}` : '',
        customerName: customer,
      });
      sheetHasData = true;
      if (amount != null) totalAmount += amount;
    }
    if (sheetHasData) sheetCount += 1;
  }

  return { rows: out, sheetCount, totalAmount, warnings };
}
