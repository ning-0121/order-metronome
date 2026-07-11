/**
 * 供应商《面料采购明细表汇总》解析器(2026-07-11)——零 token 代码解析。
 *
 * 输入格式(用户实际文件):一个工作簿,**每个 sheet = 一家供应商**(华航布行/金广诚/旺泽…)。
 * 每 sheet:
 *   r1 = 标题合并行(「XX面料采购明细表汇总」,忽略)
 *   r?  = 表头行(含「订单号」)
 *   数据行 = 订单号 | 面料 | 颜色 | 采购数量(KG) | 实到数量(KG) | 差(采购−实到,无表头) |
 *            单价(不含税) | 金额 | 备注 | 客户 | [发票状态"没见票",无表头]
 *
 * 走 SheetJS(见 excel-read.ts:老 .xls 也要读)。金额一律按不含税存。
 */
import * as XLSX from 'xlsx';

export interface FabricLedgerRow {
  supplierNameRaw: string;
  orderNoRaw: string;
  internalOrderNo: string | null; // 从订单号抽取的内部单号(≥6 位数字串)
  fabricName: string;
  color: string;
  orderedKg: number | null;
  receivedKg: number | null;
  diffKg: number | null;
  unitPriceExTax: number | null;
  amountExTax: number | null;
  invoiceStatus: string;
  deliveryNote: string;
  customerName: string;
}

export interface FabricLedgerParseResult {
  rows: FabricLedgerRow[];
  sheetCount: number;   // 有数据的供应商 sheet 数
  totalAmount: number;  // 不含税总额
  warnings: string[];
}

function s(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}.${m}.${d}`;
  }
  return String(v).trim();
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // 去掉逗号/空格/单位残留
  const cleaned = String(v).replace(/[,，\s]/g, '').replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 从订单号原文抽取内部单号:优先第一段 ≥6 位连续数字(1022918 / #1022865/102 → 1022918)。 */
export function extractInternalOrderNo(raw: string): string | null {
  if (!raw) return null;
  const m = raw.match(/\d{6,}/);
  return m ? m[0] : null;
}

const HEADER_KEYS: Record<string, keyof FabricLedgerRow | 'diff'> = {
  订单号: 'orderNoRaw',
  面料: 'fabricName',
  颜色: 'color',
  采购数量: 'orderedKg',
  实到数量: 'receivedKg',
  单价: 'unitPriceExTax',
  金额: 'amountExTax',
  备注: 'deliveryNote',
  客户: 'customerName',
};

/** 表头行 → 列索引映射。返回 null 表示该 sheet 无「订单号」表头(跳过)。 */
function locateColumns(rows: unknown[][]): {
  headerRow: number;
  col: Record<string, number>;
} | null {
  for (let r = 0; r < Math.min(rows.length, 6); r++) {
    const row = rows[r] || [];
    const joined = row.map(s).join('');
    if (!joined.includes('订单号')) continue;
    const col: Record<string, number> = {};
    row.forEach((cell, i) => {
      const t = s(cell);
      if (!t) return;
      for (const [kw, field] of Object.entries(HEADER_KEYS)) {
        if (t.includes(kw) && col[field] == null) col[field] = i;
      }
    });
    if (col.orderNoRaw == null) continue;
    // 差列(无表头):紧跟实到数量之后
    if (col.receivedKg != null) col.diff = col.receivedKg + 1;
    return { headerRow: r, col };
  }
  return null;
}

export function parseFabricLedger(buffer: Buffer): FabricLedgerParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const out: FabricLedgerRow[] = [];
  const warnings: string[] = [];
  let sheetCount = 0;
  let totalAmount = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      blankrows: false,
      defval: '',
    }) as unknown[][];
    if (!rows.length) continue;

    const loc = locateColumns(rows);
    if (!loc) {
      warnings.push(`sheet「${sheetName}」找不到「订单号」表头,已跳过`);
      continue;
    }
    const { headerRow, col } = loc;
    // 供应商名:sheet 名(去掉「面料采购明细表汇总」等后缀噪音,保留主体如「华航布行」)
    const supplierNameRaw = sheetName.trim();

    let sheetHasData = false;
    let carryOrder = '';   // 订单号向下填充(首行填、下面留空)
    let carryFabric = '';  // 面料向下填充(同订单内)
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const get = (k: string): unknown => (col[k] != null ? row[col[k]] : undefined);

      // 小计/合计/总金额/标题行/重复表头 → 跳过(否则金额重复计入 / 表头当数据)
      const rowText = row.map(s).join('');
      if (/总金额|合计|小计|总计|明细表汇总|采购数量|实到数量/.test(rowText)) continue;

      const rawOrder = s(get('orderNoRaw'));
      const rawFabric = s(get('fabricName'));
      const color = s(get('color'));
      const amountExTax = num(get('amountExTax'));
      const unitPriceExTax = num(get('unitPriceExTax'));
      const orderedKg = num(get('orderedKg'));
      const receivedKg = num(get('receivedKg'));

      // 纯空行(本行自身所有关键格都空)→ 跳过,不做填充
      if (!rawOrder && !rawFabric && !color && amountExTax == null && unitPriceExTax == null
          && orderedKg == null && receivedKg == null) {
        continue;
      }

      // 向下填充:新订单号出现 → 更新并重置面料填充;面料同理
      if (rawOrder) { carryOrder = rawOrder; carryFabric = ''; }
      if (rawFabric) carryFabric = rawFabric;
      const orderNoRaw = rawOrder || carryOrder;
      const fabricName = rawFabric || carryFabric;

      // 发票状态:客户列之后、含「票」字的任意列(如「没见票」)
      let invoiceStatus = '';
      const startScan = (col.customerName != null ? col.customerName : (col.amountExTax ?? 0)) + 1;
      for (let c = startScan; c < row.length; c++) {
        const t = s(row[c]);
        if (t && /票/.test(t)) { invoiceStatus = t; break; }
      }

      const diffKg = col.diff != null ? num(row[col.diff]) : null;

      out.push({
        supplierNameRaw,
        orderNoRaw,
        internalOrderNo: extractInternalOrderNo(orderNoRaw),
        fabricName,
        color,
        orderedKg,
        receivedKg,
        diffKg,
        unitPriceExTax,
        amountExTax,
        invoiceStatus,
        deliveryNote: s(get('deliveryNote')),
        customerName: s(get('customerName')),
      });
      sheetHasData = true;
      if (amountExTax != null) totalAmount += amountExTax;
    }
    if (sheetHasData) sheetCount += 1;
  }

  return { rows: out, sheetCount, totalAmount, warnings };
}
