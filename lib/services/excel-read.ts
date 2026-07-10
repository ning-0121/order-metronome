/**
 * 服务端 Excel 读取(2026-07-10)——统一走 SheetJS。
 *
 * ⚠️ 为什么不用 exceljs:exceljs 的 `workbook.xlsx.load` 只认 OOXML(.xlsx),
 * 遇到老式 .xls(BIFF)会**静默返回空表**(sheets=[]),不报错。很多客户(伊彤等)
 * 还在用老 .xls,结果 PO 被读成空 → AI/零token 解析拿到零内容 → 识别全错。
 * SheetJS(xlsx)同时支持 .xls / .xlsx / .csv,故 PO 读取统一改走这里。
 */
import * as XLSX from 'xlsx';

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

function norm(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return fmtDate(v);
  return String(v);
}

function sheetsToText(wb: XLSX.WorkBook): string {
  const lines: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    lines.push(`\n=== Sheet: ${name} ===`);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: '' });
    rows.forEach((row, i) => {
      const cells = (row as unknown[]).map(norm);
      if (cells.some((c) => c.trim())) lines.push(`Row ${i + 1}: ${cells.join(' | ')}`);
    });
  }
  return lines.join('\n');
}

/** 读全部 sheet 为纯文本(喂 AI 解析)。老 .xls / .xlsx / .csv 都支持。 */
export function readWorkbookText(buffer: Buffer, fileName = ''): string {
  if (fileName.toLowerCase().endsWith('.csv')) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
      const t = sheetsToText(wb);
      if (t.trim()) return t;
    } catch { /* 落到 utf-8 兜底 */ }
    return buffer.toString('utf-8');
  }
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return sheetsToText(wb);
}

/** 读第一个非空 sheet 为二维数组(喂零 token 代码解析器 parseOrderSheet)。 */
export function readFirstSheetRows(buffer: Buffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true, defval: null }) as unknown[][];
    if (rows.some((r) => r.some((c) => c != null && String(c).trim()))) return rows;
  }
  return [];
}
