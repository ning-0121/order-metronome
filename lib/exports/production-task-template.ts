import ExcelJS from 'exceljs';
import path from 'node:path';
import {
  PRODUCTION_TASK_CELLS as C, PRODUCTION_TASK_SHEETS, PRODUCTION_TASK_TEMPLATE_RELATIVE_PATH,
  type ProductionTaskTemplateModel, type ProductionTaskSizeMeasurement,
} from './production-task-template-map';
import { PRODUCTION_TASK_TEMPLATE_BASE64 } from './production-task-template-data';
import { orderSizeKeys } from '@/lib/utils/size-sort';

export function productionTaskTemplatePath(root = process.cwd()) {
  return path.join(root, PRODUCTION_TASK_TEMPLATE_RELATIVE_PATH);
}

/**
 * 把【上传的尺码表 xlsx 整张】照搬进生产任务单的「尺寸表」sheet(2026-07-20 用户拍板)。
 * 绕开脆弱的尺码表解析器(NO_RECOGNIZABLE_TABLE)——任何布局的尺码表都能原样进生产单。
 * 复制单元格值 + 基础样式 + 行高/列宽 + 合并格。成功返回 true;失败(读不出/无表)返回 false,调用方保留原尺寸表。
 */
export async function overlayRawSizeChart(
  workbook: ExcelJS.Workbook,
  uploadBuffer: ArrayBuffer | Buffer,
): Promise<boolean> {
  try {
    const up = new ExcelJS.Workbook();
    await up.xlsx.load(uploadBuffer as any);
    const src = up.worksheets.find(w => w.rowCount > 0) || up.worksheets[0];
    const dst = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.size);
    if (!src || !dst) return false;
    // 清空目标 sheet 现有内容(值)
    dst.eachRow({ includeEmpty: true }, (row) => { row.eachCell({ includeEmpty: true }, (cell) => { cell.value = null; }); });
    // 复制源 sheet:值 + 样式 + 行高
    src.eachRow({ includeEmpty: true }, (row, r) => {
      if (row.height) dst.getRow(r).height = row.height;
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const d = dst.getCell(r, c);
        d.value = cell.value as any;
        try { d.style = JSON.parse(JSON.stringify(cell.style || {})); } catch { /* 样式复制失败忽略 */ }
      });
    });
    // 列宽
    (src.columns || []).forEach((col, i) => { if (col && col.width) dst.getColumn(i + 1).width = col.width; });
    // 合并单元格
    const merges: string[] = (src.model as any)?.merges || [];
    for (const m of merges) { try { dst.mergeCells(m); } catch { /* 已合并/冲突忽略 */ } }
    return true;
  } catch { return false; }
}

/**
 * 从【内嵌 base64 母版】读取(2026-07-20 修:导出是共享 server-action 包,Vercel 的
 * outputFileTracingIncludes 按页面路由不命中它 → process.cwd()/public 读不到母版“缺失”)。
 * 内嵌成模块 import 必被打包,dev/serverless 都可用,根治 fs/public 问题。root 参数保留仅为向后兼容。
 */
export async function loadProductionTaskTemplate(_root = process.cwd()) {
  const buffer = Buffer.from(PRODUCTION_TASK_TEMPLATE_BASE64, 'base64');
  if (!buffer.length) throw new Error('生产任务单母版缺失：内嵌母版为空(请重跑 gen 脚本)');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const names = workbook.worksheets.map(s => s.name);
  if (names.length !== 2 || names[0] !== PRODUCTION_TASK_SHEETS.main || names[1] !== PRODUCTION_TASK_SHEETS.size) {
    throw new Error(`生产任务单母版工作表不匹配：${names.join('、')}`);
  }
  return workbook;
}

const blank = (v: unknown) => v === null || v === undefined ? '' : v as ExcelJS.CellValue;
const dateValue = (v: string | Date | null | undefined) => v ? new Date(v) : '';
const safeSheetName = (name: string) => name.replace(/[\\/*?:[\]]/g, '_').slice(0, 31);

function set(ws: ExcelJS.Worksheet, address: string, value: unknown) { ws.getCell(address).value = blank(value); }
function textList(values: Array<string | null | undefined>) { return values.filter(Boolean).join('，'); }

function measurementValue(row: ProductionTaskSizeMeasurement | undefined, size: string) {
  if (!row?.values) return '';
  if (row.values[size] != null) return row.values[size]!;
  const key = Object.keys(row.values).find(k => k.trim().toLowerCase() === size.trim().toLowerCase());
  return key ? row.values[key] ?? '' : '';
}

function addOverflowSheet(workbook: ExcelJS.Workbook, model: ProductionTaskTemplateModel, sizes: string[]) {
  if (model.colors.length <= 4 && sizes.length <= 3 && !model.colors.some(c => c.styleNumber && c.styleNumber !== model.styleNumber)) return;
  const ws = workbook.addWorksheet(safeSheetName('款色尺码明细附页'));
  const template = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.main)!;
  const source = template.getRow(6);
  const columns = ['款号', '主布颜色', '箱数', '数量', ...sizes, '客户包装', '数量口径'];
  columns.forEach((title, i) => {
    const cell = ws.getCell(1, i + 1); cell.value = title;
    const sourceCell = source.getCell(Math.min(i + 1, 12)); cell.style = { ...sourceCell.style };
    ws.getColumn(i + 1).width = i === columns.length - 2 ? 31.25 : (template.getColumn(Math.min(i + 1, 12)).width || 12);
  });
  model.colors.forEach((color, index) => {
    const row = ws.getRow(index + 2); row.height = template.getRow(7).height;
    const values: unknown[] = [color.styleNumber || model.styleNumber, textList([color.colorEn, color.colorCn]) || color.color,
      color.cartonCount, color.quantity, ...sizes.map(s => color.sizes?.[s] ?? ''), model.customerPackaging,
      model.quantityBasis === 'set' ? '套' : model.quantityBasis === 'component' ? '组件' : '件'];
    values.forEach((value, i) => { const cell = row.getCell(i + 1); cell.value = blank(value); cell.style = { ...template.getRow(7).getCell(Math.min(i + 1, 12)).style }; });
  });
  ws.pageSetup = { ...template.pageSetup, printArea: `A1:${ws.getColumn(columns.length).letter}${model.colors.length + 1}` };
}

// 列号 ↔ 字母
const colToNum = (s: string) => [...s].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0);
const numToCol = (n: number) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/**
 * 动态扩展生产任务单主表(2026-07-24 用户#4):按录入的颜色数/尺码数在母版主表插行插列。
 * 母版固定:尺码列 E/F/G(3 列),颜色行 7-10(4 行),客户包装 H:L。
 *  - 尺码 > 3:在第 8 列(客户包装 H 前)插 (n-3) 列;
 *  - 颜色 > 4:在第 11 行(总计前)插 (n-4) 行。
 * 合并格「先全拆 → splice → 按位移重合」保证不错位;新行/列仿邻近样式。
 * 返回:extraRows/extraCols 位移 + 尺码列字母表(≥3,含要清空的母版残列)+ 客户包装列 + 末列。
 */
function expandMainSheet(main: ExcelJS.Worksheet, nColors: number, nSizes: number) {
  const extraRows = Math.max(0, nColors - 4);
  const extraCols = Math.max(0, nSizes - 3);
  const COL_INS = 8, ROW_INS = 11;
  const physSizes = Math.max(3, nSizes);
  const sizeCols = Array.from({ length: physSizes }, (_, i) => numToCol(5 + i));
  const ret = { extraRows, extraCols, sizeCols, packCol: numToCol(8 + extraCols), lastCol: numToCol(12 + extraCols) };
  if (extraRows === 0 && extraCols === 0) return ret;   // 母版够放,不动

  const parse = (m: string) => { const x = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(m); return x ? { l: colToNum(x[1]), t: +x[2], r: colToNum(x[3]), b: +x[4] } : null; };
  // 1) 记录并拆掉所有合并格(splice 对合并格支持不稳,手动重合)
  const merges = [...(((main.model as any).merges as string[]) || [])];
  for (const m of merges) { try { main.unMergeCells(m); } catch { /* 忽略 */ } }
  // 2) 先插列再插行
  if (extraCols > 0) main.spliceColumns(COL_INS, 0, ...Array.from({ length: extraCols }, () => [] as any[]));
  if (extraRows > 0) main.spliceRows(ROW_INS, 0, ...Array.from({ length: extraRows }, () => [] as any[]));
  // 3) 按位移重合并:列 ≥8 的 +extraCols;行 ≥11 的 +extraRows
  for (const m of merges) {
    const p = parse(m); if (!p) continue;
    const l = p.l >= COL_INS ? p.l + extraCols : p.l, r = p.r >= COL_INS ? p.r + extraCols : p.r;
    const t = p.t >= ROW_INS ? p.t + extraRows : p.t, b = p.b >= ROW_INS ? p.b + extraRows : p.b;
    try { main.mergeCells(`${numToCol(l)}${t}:${numToCol(r)}${b}`); } catch { /* 冲突忽略 */ }
  }
  // 4) 新尺码列仿母版 G 列(第7列)样式/宽;新颜色行仿第7行样式/高 + 客户包装合并
  for (let i = 0; i < extraCols; i++) {
    const c = COL_INS + i;
    main.getColumn(c).width = main.getColumn(7).width;
    for (let rr = 6; rr <= 10; rr++) { try { main.getCell(rr, c).style = JSON.parse(JSON.stringify(main.getCell(rr, 7).style || {})); } catch { /* */ } }
  }
  for (let i = 0; i < extraRows; i++) {
    const rr = ROW_INS + i;
    main.getRow(rr).height = main.getRow(7).height;
    for (let cc = 1; cc <= 12 + extraCols; cc++) { try { main.getCell(rr, cc).style = JSON.parse(JSON.stringify(main.getCell(7, cc).style || {})); } catch { /* */ } }
    try { main.mergeCells(`${numToCol(8 + extraCols)}${rr}:${numToCol(12 + extraCols)}${rr}`); } catch { /* */ }
  }
  return ret;
}

export async function buildProductionTaskWorkbook(model: ProductionTaskTemplateModel, root = process.cwd()) {
  const workbook = await loadProductionTaskTemplate(root);
  const main = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.main)!;
  const sizeSheet = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.size)!;
  // ── 母版残留嵌图清洗(2026-07-27)── 母版取自真实旧单 LU21-SET,主表 col11/row5 烤死了一张粉色套装
  //   产品图,任何款下载都会带出这张 LU21 的图(串味)。本(模板)路径不贴产品图,直接清空主表全部嵌图。
  try { (main as unknown as { _media: unknown[] })._media = []; } catch { /* 忽略 */ }
  const sizes = orderSizeKeys(model.sizeOrder?.length ? model.sizeOrder : model.colors.flatMap(c => Object.keys(c.sizes || {}))).filter(Boolean);
  const baseSizes = sizes.slice(0, 3);   // 尺寸表 sheet 仍用前3码(#5:上传的尺码表会整张覆盖它)

  // 主表动态扩展(#4):按颜色数/尺码数插行插列;失败回退母版原版式(前3码4色),永不 brick 导出。
  let mainSizes = sizes;
  let ex = { extraRows: 0, extraCols: 0, sizeCols: ['E', 'F', 'G'] as string[], packCol: 'H', lastCol: 'L' };
  try { ex = expandMainSheet(main, model.colors.length, sizes.length); }
  catch { mainSizes = baseSizes; ex = { extraRows: 0, extraCols: 0, sizeCols: ['E', 'F', 'G'], packCol: 'H', lastCol: 'L' }; }
  // 插行/列后,原 C 映射固定格坐标要位移:列 ≥8 的 +extraCols,行 ≥11 的 +extraRows
  const shift = (addr: string) => {
    const x = /^([A-Z]+)(\d+)$/.exec(addr); if (!x) return addr;
    let cn = colToNum(x[1]); let rn = +x[2];
    if (cn >= 8) cn += ex.extraCols;
    if (rn >= 11) rn += ex.extraRows;
    return `${numToCol(cn)}${rn}`;
  };

  set(main, shift(C.header.internalOrderNumber), model.customer
    ? `${model.internalOrderNumber || ''}（${model.customer}）` : model.internalOrderNumber);
  set(main, shift(C.header.orderDate), dateValue(model.orderDate));
  set(main, shift(C.header.productName), model.productName);
  set(main, shift(C.header.materialComposition), model.materialComposition);
  set(main, shift(C.header.deliveryDate), dateValue(model.deliveryDate));
  set(main, shift(C.header.fabricWeight), model.fabricWeight);
  set(main, shift(C.header.totalQuantity), model.totalQuantity);
  // 颜色行:母版4行 + 新插行,逐行写实际颜色;不足则清空(抹掉母版残留样例色)
  const totalColorRows = 4 + ex.extraRows;
  for (let i = 0; i < totalColorRows; i++) {
    const row = 7 + i;
    const color = model.colors[i];
    set(main, `${C.colorColumns.styleNumber}${row}`, color ? (color.styleNumber || model.styleNumber) : '');
    set(main, `${C.colorColumns.color}${row}`, color ? (textList([color.colorEn, color.colorCn]) || color.color) : '');
    set(main, `${C.colorColumns.cartonCount}${row}`, color?.cartonCount ?? '');
    set(main, `${C.colorColumns.colorQuantity}${row}`, color?.quantity ?? '');
    ex.sizeCols.forEach((col, j) => set(main, `${col}${row}`, color?.sizes?.[mainSizes[j]] ?? ''));
  }
  // 尺码表头行6(母版残余尺码列一并写空)
  ex.sizeCols.forEach((col, i) => set(main, `${col}6`, mainSizes[i] || ''));
  set(main, `${ex.packCol}7`, model.customerPackaging);
  set(main, shift(C.totals.cartonCount), model.colors.reduce((n, c) => n + (Number(c.cartonCount) || 0), 0));
  set(main, shift(C.totals.quantity), model.totalQuantity ?? model.colors.reduce((n, c) => n + (Number(c.quantity) || 0), 0));
  set(main, shift(C.consumption), (model.fabrics || []).map(f => [f.name, f.consumption, f.unit, f.basis ? `(${f.basis})` : ''].filter(v => v !== null && v !== undefined && v !== '').join(' ')).join('；'));
  set(main, shift(C.sampling.preProductionDate), model.sampling?.preProductionDate);
  set(main, shift(C.sampling.preProductionRequirement), model.sampling?.preProductionRequirement);
  set(main, shift(C.sampling.shipmentDate), model.sampling?.shipmentDate);
  set(main, shift(C.sampling.shipmentRequirement), model.sampling?.shipmentRequirement);
  for (const [key, address] of Object.entries(C.requirements)) set(main, shift(address), model.requirements?.[key as keyof NonNullable<typeof model.requirements>]);
  set(main, shift(C.signature.receiver), model.receiver); set(main, shift(C.signature.receiptTime), dateValue(model.receiptTime));

  sizeSheet.getCell(C.size.title).value = { richText: [
    { font: { name: 'Calibri', size: 20, bold: true, color: { argb: 'FFFF0000' } }, text: model.styleNumber || '' },
    { font: { name: '宋体', size: 20, bold: true, color: { argb: 'FFFF0000' } }, text: '尺寸表' },
  ] };
  C.size.topSizeColumns.forEach((column, i) => set(sizeSheet, `${column}3`, baseSizes[i] || ''));
  C.size.bottomSizeColumns.forEach((column, i) => set(sizeSheet, `${column}3`, baseSizes[i] || ''));
  C.size.rows.forEach((rowNo, i) => {
    const top = model.sizeChart?.top?.[i]; const bottom = model.sizeChart?.bottom?.[i];
    set(sizeSheet, `${C.size.topSequence}${rowNo}`, top?.sequence);
    set(sizeSheet, `${C.size.topPosition}${rowNo}`, top?.position);
    C.size.topSizeColumns.forEach((column, j) => set(sizeSheet, `${column}${rowNo}`, measurementValue(top, baseSizes[j] || '')));
    set(sizeSheet, `${C.size.bottomPosition}${rowNo}`, bottom?.position);
    C.size.bottomSizeColumns.forEach((column, j) => set(sizeSheet, `${column}${rowNo}`, measurementValue(bottom, baseSizes[j] || '')));
  });
  // ── 尺寸表「串味」修复(2026-07-24)──
  // 母版取自真实旧单(LU21-SET),尺寸表 rows 2-3 带款式专属部位标签「上衣部位/长裤部位」+「标准尺寸(英寸)」。
  // 上面只填/清了 rows 4-13 的值,rows 2-3 表头没覆盖 → 没上传/未解析尺码表的单会残留 LU21 空骨架。
  // 规则:某块(上衣/长裤)有尺码数据 → 通用表头「部位 / 标准尺寸(英寸)」;无数据 → 整块表头(含序号、S/M/L)清空,不留误导空骨架。
  //   注:真正上传了尺码表的单走 overlayRawSizeChart 整张替换,不经此分支;这里只兜底「无上传」的解析/空态。
  const hasChartRows = (rows?: ProductionTaskSizeMeasurement[] | null) =>
    Array.isArray(rows) && rows.some((r) => r && (r.position != null || (r.values && Object.keys(r.values).length > 0)));
  const hasTopChart = hasChartRows(model.sizeChart?.top);
  const hasBottomChart = hasChartRows(model.sizeChart?.bottom);
  set(sizeSheet, `${C.size.topSequence}2`, hasTopChart ? '序号' : '');
  set(sizeSheet, `${C.size.topSequence}3`, hasTopChart ? '序号' : '');
  set(sizeSheet, `${C.size.topPosition}2`, hasTopChart ? '部位' : '');
  set(sizeSheet, `${C.size.topPosition}3`, hasTopChart ? '部位' : '');
  C.size.topSizeColumns.forEach((column) => {
    set(sizeSheet, `${column}2`, hasTopChart ? '标准尺寸（英寸）' : '');
    if (!hasTopChart) set(sizeSheet, `${column}3`, '');   // 无数据 → 连 S/M/L 表头一起清
  });
  set(sizeSheet, `${C.size.bottomPosition}2`, hasBottomChart ? '部位' : '');
  set(sizeSheet, `${C.size.bottomPosition}3`, hasBottomChart ? '部位' : '');
  C.size.bottomSizeColumns.forEach((column) => {
    set(sizeSheet, `${column}2`, hasBottomChart ? '标准尺寸（英寸）' : '');
    if (!hasBottomChart) set(sizeSheet, `${column}3`, '');
  });
  addOverflowSheet(workbook, model, sizes);
  return workbook;
}

/**
 * 清洗母版残留的 LU21-SET 工作表标签名 → 通用名(2026-07-27)。
 * 母版取自真实旧单,两张 sheet 名硬编码为「LU21-SET 上衣 / LU21-SET尺寸表」,导出 tab 一直带 LU21。
 * ⚠️ 必须在【所有按 PRODUCTION_TASK_SHEETS 名 getWorksheet 的操作(含 overlayRawSizeChart)之后】调,否则查不到表。
 */
export function finalizeProductionTaskSheetNames(workbook: ExcelJS.Workbook) {
  const m = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.main); if (m) m.name = '生产任务单';
  const s = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.size); if (s) s.name = '尺寸表';
}

export function safeProductionTaskFilename(internalOrderNumber?: string | null, styleNumber?: string | null) {
  const safe = (v: string | null | undefined, fallback: string) => String(v || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return `${safe(internalOrderNumber, '订单')}_生产任务单_${safe(styleNumber, '款号待补')}.xlsx`;
}
