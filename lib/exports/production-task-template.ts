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

export async function buildProductionTaskWorkbook(model: ProductionTaskTemplateModel, root = process.cwd()) {
  const workbook = await loadProductionTaskTemplate(root);
  const main = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.main)!;
  const sizeSheet = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.size)!;
  const sizes = orderSizeKeys(model.sizeOrder?.length ? model.sizeOrder : model.colors.flatMap(c => Object.keys(c.sizes || {}))).filter(Boolean);
  const baseSizes = sizes.slice(0, 3);

  set(main, C.header.internalOrderNumber, model.customer
    ? `${model.internalOrderNumber || ''}（${model.customer}）` : model.internalOrderNumber);
  set(main, C.header.orderDate, dateValue(model.orderDate));
  set(main, C.header.productName, model.productName);
  set(main, C.header.materialComposition, model.materialComposition);
  set(main, C.header.deliveryDate, dateValue(model.deliveryDate));
  set(main, C.header.fabricWeight, model.fabricWeight);
  set(main, C.header.totalQuantity, model.totalQuantity);
  C.colorRows.forEach((row, index) => {
    const color = model.colors[index];
    set(main, `${C.colorColumns.styleNumber}${row}`, color ? (color.styleNumber || model.styleNumber) : '');
    set(main, `${C.colorColumns.color}${row}`, color ? (textList([color.colorEn, color.colorCn]) || color.color) : '');
    set(main, `${C.colorColumns.cartonCount}${row}`, color?.cartonCount);
    set(main, `${C.colorColumns.colorQuantity}${row}`, color?.quantity);
    C.colorColumns.sizes.forEach((column, i) => set(main, `${column}${row}`, color?.sizes?.[baseSizes[i]]));
  });
  C.colorColumns.sizes.forEach((column, i) => set(main, `${column}6`, baseSizes[i] || ''));
  set(main, C.colorColumns.packaging + '7', model.customerPackaging);
  set(main, C.totals.cartonCount, model.colors.reduce((n, c) => n + (Number(c.cartonCount) || 0), 0));
  set(main, C.totals.quantity, model.totalQuantity ?? model.colors.reduce((n, c) => n + (Number(c.quantity) || 0), 0));
  set(main, C.consumption, (model.fabrics || []).map(f => [f.name, f.consumption, f.unit, f.basis ? `(${f.basis})` : ''].filter(v => v !== null && v !== undefined && v !== '').join(' ')).join('；'));
  set(main, C.sampling.preProductionDate, model.sampling?.preProductionDate);
  set(main, C.sampling.preProductionRequirement, model.sampling?.preProductionRequirement);
  set(main, C.sampling.shipmentDate, model.sampling?.shipmentDate);
  set(main, C.sampling.shipmentRequirement, model.sampling?.shipmentRequirement);
  for (const [key, address] of Object.entries(C.requirements)) set(main, address, model.requirements?.[key as keyof NonNullable<typeof model.requirements>]);
  set(main, C.signature.receiver, model.receiver); set(main, C.signature.receiptTime, dateValue(model.receiptTime));

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
  addOverflowSheet(workbook, model, sizes);
  return workbook;
}

export function safeProductionTaskFilename(internalOrderNumber?: string | null, styleNumber?: string | null) {
  const safe = (v: string | null | undefined, fallback: string) => String(v || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return `${safe(internalOrderNumber, '订单')}_生产任务单_${safe(styleNumber, '款号待补')}.xlsx`;
}
