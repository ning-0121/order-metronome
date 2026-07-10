/**
 * 客户订单文件(合同/生产单式 Excel)· 确定性解析器 —— 纯函数,零 AI/零 token。
 * 表头驱动 + **尺码列自动识别**(适配 S/M/L 或 XS-XXL 或数码尺等不同尺码集)。
 * 输出对齐 order_line_items:每款每色一条,含逐尺码数量 sizes、合计、单价、金额。
 * 识别不到的字段留空,业务在富录入表兜底核对。
 */

export interface ParsedOrderLine {
  style_no: string;
  color: string | null;
  color_ref: string | null;
  sizes: Record<string, number>;   // { S:600, M:600, L:600 }
  qty_total: number;
  unit_price: number | null;
  amount: number | null;
}
export interface ParsedOrderSheet {
  lines: ParsedOrderLine[];
  sizeNames: string[];             // 识别到的尺码列名(有序)
  headerRow: number;               // 1-based;-1=未找到
}

/** 单元格取文本:兼容 exceljs 的富文本 {richText}、公式 {result}、超链接 {text}。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t?.text ?? '').join('');
    if (o.result !== undefined) return o.result === null || o.result === undefined ? '' : String(o.result);
    if (o.text !== undefined) return String(o.text ?? '');
    if (o.hyperlink !== undefined) return String(o.text ?? o.hyperlink ?? '');
    return '';   // 未知对象 → 空(避免 [object Object])
  }
  return String(v);
}
const norm = (v: unknown): string => cellText(v).replace(/\s+/g, '').toLowerCase();
const numOrNull = (v: unknown): number | null => {
  const s = cellText(v).replace(/[,¥$]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
};
const strOrNull = (v: unknown): string | null => { const s = cellText(v).trim(); return s || null; };

/** 是否像尺码列名:XS/S/M/L/XL/XXL/2XL../F/均码/自由 或 纯数字(数码尺 2 4 6..)。 */
function isSizeToken(h: unknown): boolean {
  const n = norm(h);
  if (!n) return false;
  if (/^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|[1-9]xl)$/.test(n)) return true;
  if (/^[1-9]x$/.test(n)) return true;                  // 加大码 1X/2X/3X..(伊彤等)
  if (/^(f|os|均码|均|自由码|free)$/.test(n)) return true;
  if (/^\d{1,3}$/.test(n)) return true;                 // 数码尺 2/4/6/28/30..
  if (/^\d{1,3}[- ]?\d{0,3}$/.test(n) && n.length <= 6) return true; // 26-28 等
  return false;
}
function findCol(header: unknown[], ...keywords: string[]): number {
  for (const kw of keywords) { const k = norm(kw); const i = header.findIndex((h) => norm(h).includes(k)); if (i >= 0) return i; }
  return -1;
}

export function parseOrderSheet(rows: unknown[][]): ParsedOrderSheet {
  const empty: ParsedOrderSheet = { lines: [], sizeNames: [], headerRow: -1 };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // 1) 表头行:含 "款号" 或 "style"
  let hIdx = -1;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    if ((rows[r] || []).some((c) => { const n = norm(c); return n.includes('款号') || n === 'style' || n.includes('styleno'); })) { hIdx = r; break; }
  }
  if (hIdx === -1) return empty;
  const header = rows[hIdx] || [];

  // 2) 关键列
  const cStyle = findCol(header, '款号', 'style');
  const cColor = findCol(header, '颜色', 'color');
  const cColorRef = findCol(header, '颜色参考', '色号', '颜色代码');
  const cPrice = findCol(header, '单价', 'fob', 'price');
  const cAmount = findCol(header, '金额', 'amount', '总价');
  const cQtyTotal = findCol(header, '合计', '总数', '数量', 'qty', 'total');

  // 3) 尺码列:在颜色列右侧、单价/金额左侧,表头像尺码。
  const leftBound = Math.max(cColorRef, cColor, cStyle);
  const rightBound = Math.min(...[cPrice, cAmount].filter((x) => x > 0).concat([header.length]));
  const sizeCols: Array<{ col: number; name: string }> = [];
  for (let c = leftBound + 1; c < rightBound; c++) {
    if (isSizeToken(header[c])) sizeCols.push({ col: c, name: String(header[c]).trim() });
  }

  // 4) 数据行
  const lines: ParsedOrderLine[] = [];
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const style = cStyle >= 0 ? strOrNull(row[cStyle]) : null;
    if (!style) continue;
    // 跳过合计/总计行(不是真实款):否则"合计"会被当成一个款号
    if (/^(合计|总计|小计|total|subtotal|sum)$/.test(norm(style))) continue;

    const sizes: Record<string, number> = {};
    let sizeSum = 0;
    for (const s of sizeCols) {
      const q = numOrNull(row[s.col]);
      if (q != null && q > 0) { sizes[s.name] = q; sizeSum += q; }
    }
    const total = (cQtyTotal >= 0 ? numOrNull(row[cQtyTotal]) : null) ?? (sizeSum > 0 ? sizeSum : 0);

    // 过滤非订单行(如"布面要求/尺寸要求/包装方法"等合同条款):必须有尺码数量或合计数量
    if (sizeSum === 0 && total === 0) continue;

    lines.push({
      style_no: style,
      color: cColor >= 0 ? strOrNull(row[cColor]) : null,
      color_ref: cColorRef >= 0 ? strOrNull(row[cColorRef]) : null,
      sizes,
      qty_total: total,
      unit_price: cPrice >= 0 ? numOrNull(row[cPrice]) : null,
      amount: cAmount >= 0 ? numOrNull(row[cAmount]) : null,
    });
  }

  return { lines, sizeNames: sizeCols.map((s) => s.name), headerRow: hIdx + 1 };
}
