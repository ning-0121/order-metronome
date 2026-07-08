/**
 * 内部成本核算单(报价单)· 确定性解析器 —— 纯函数,零 AI/零 token。
 * 表头驱动(容错列顺序变动):按表头文字定位列,读每款(STYLE)一行的:
 *   款级:加工价(cmt)、面料成本、辅料费用合计(trim_budget)、成分、备注
 *   面料 A/B/C 三块:名称、面料工厂(供应商)、净布价(报价单价)、单位、单件用量(公斤/米=报价单耗)
 * 输出对齐报价基线:每款 × 每料一条 line + 每款预算(cmt/trim)。
 */

export interface ParsedFabricLine {
  style_no: string;
  material_name: string;
  supplier: string | null;
  quote_unit_price: number | null;   // 净布价(不含税)
  quote_unit: string | null;
  quote_consumption: number | null;   // 单件用量(公斤/米)
  composition: string | null;
  notes: string | null;
}
export interface ParsedStyleBudget {
  style_no: string;
  cmt: number | null;                  // 加工价
  fabric_cost: number | null;          // 面料成本
  trim_budget: number | null;          // 辅料费用合计
}
export interface ParsedQuoteSheet {
  lines: ParsedFabricLine[];
  styleBudgets: ParsedStyleBudget[];
  headerRow: number;                   // 1-based;-1=未找到表头
}

const norm = (v: unknown): string => String(v ?? '').replace(/\s+/g, '').toLowerCase();
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  // 剥掉任何非数字字符(半角¥ U+00A5 / 全角￥ U+FFE5 / $ / 逗号 / 空格 等)——
  // 之前只剥半角¥,全角￥的报价单价全变 NaN→null(用户实测"辅料价格识别不出来")。
  const cleaned = String(v).replace(/[^\d.\-]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
};
const strOrNull = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** 表头里含某关键字的列(0-based),找不到返回 -1。 */
function findCol(header: unknown[], keyword: string): number {
  const k = norm(keyword);
  return header.findIndex((h) => norm(h).includes(k));
}
/**
 * 面料块锚点。用 "面料工厂" 列作可靠锚(每块面料一个,恒能读到),名称列=工厂列-1。
 * 比找 "面料A/B/C" 表头稳:实测面料A表头常因合并单元格在 exceljs 读成空。
 * 返回每块的 名称列(0-based)。
 */
function fabricNameCols(header: unknown[]): number[] {
  const out: number[] = [];
  header.forEach((h, i) => { if (norm(h) === '面料工厂' && i > 0) out.push(i - 1); });
  return out;
}

/**
 * rows:表格二维数组(每行=单元格值数组,1-based 语义但数组 0-based)。
 * 自动找表头行(含 "STYLE" 的行),之后每有 STYLE 值的行=一款。
 */
export function parseCostSheet(rows: unknown[][]): ParsedQuoteSheet {
  const empty: ParsedQuoteSheet = { lines: [], styleBudgets: [], headerRow: -1 };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // 1) 找表头行:含 "style" 的行
  let hIdx = -1;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    if ((rows[r] || []).some((c) => norm(c) === 'style')) { hIdx = r; break; }
  }
  if (hIdx === -1) return empty;
  const header = rows[hIdx] || [];

  // 2) 款级列
  const cStyle = findCol(header, 'style');
  const cCmt = findCol(header, '加工价');
  const cFabricCost = findCol(header, '面料成本');
  const cTrim = findCol(header, '辅料费用合计');
  const cComp = header.findIndex((h) => { const n = norm(h); return n.includes('composition') || n.includes('成分'); });
  const cNote = header.findIndex((h) => norm(h) === '备注');

  // 3) 面料块:名称列(=面料工厂列-1)到下一块名称列之间,按表头文字定位子列
  const nameCols = fabricNameCols(header);
  const blocks = nameCols.map((start, i) => {
    const end = i + 1 < nameCols.length ? nameCols[i + 1] : (cTrim > start ? cTrim : header.length);
    const within = (kw: string) => { for (let c = start; c < end; c++) if (norm(header[c]).includes(norm(kw))) return c; return -1; };
    // 单耗:优先"单件用量"里带"公斤"或"米"的(非"平方")
    let cCons = -1;
    for (let c = start; c < end; c++) {
      const n = norm(header[c]);
      if (n.includes('单件用量') && (n.includes('公斤') || n.includes('米'))) { cCons = c; break; }
    }
    return {
      name: start,
      supplier: within('面料工厂'),
      price: within('净布价'),
      unit: (() => { for (let c = start; c < end; c++) if (norm(header[c]) === '单位') return c; return -1; })(),
      cons: cCons,
    };
  });

  const lines: ParsedFabricLine[] = [];
  const styleBudgets: ParsedStyleBudget[] = [];

  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const style = cStyle >= 0 ? strOrNull(row[cStyle]) : null;
    if (!style) continue;   // 无款号 = 非数据行

    styleBudgets.push({
      style_no: style,
      cmt: cCmt >= 0 ? numOrNull(row[cCmt]) : null,
      fabric_cost: cFabricCost >= 0 ? numOrNull(row[cFabricCost]) : null,
      trim_budget: cTrim >= 0 ? numOrNull(row[cTrim]) : null,
    });

    const composition = cComp >= 0 ? strOrNull(row[cComp]) : null;
    const notes = cNote >= 0 ? strOrNull(row[cNote]) : null;

    for (const b of blocks) {
      const name = strOrNull(row[b.name]);
      if (!name) continue;   // 该款没这块面料
      lines.push({
        style_no: style,
        material_name: name,
        supplier: b.supplier >= 0 ? strOrNull(row[b.supplier]) : null,
        quote_unit_price: b.price >= 0 ? numOrNull(row[b.price]) : null,
        quote_unit: b.unit >= 0 ? strOrNull(row[b.unit]) : null,
        quote_consumption: b.cons >= 0 ? numOrNull(row[b.cons]) : null,
        composition,
        notes,
      });
    }
  }

  return { lines, styleBudgets, headerRow: hIdx + 1 };
}
