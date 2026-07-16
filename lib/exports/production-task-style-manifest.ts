import type ExcelJS from 'exceljs';
import { PRODUCTION_TASK_CELLS, PRODUCTION_TASK_FIXED_CELLS, PRODUCTION_TASK_SHEETS } from './production-task-template-map';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}

export function productionTaskStyleManifest(workbook: ExcelJS.Workbook) {
  return workbook.worksheets.slice(0, 2).map(ws => ({
    name: ws.name,
    usedRange: `${ws.getCell(1, 1).address}:${ws.getCell(ws.rowCount, ws.columnCount).address}`,
    merges: [...(ws.model.merges || [])].sort(),
    columns: Array.from({ length: ws.columnCount }, (_, i) => ws.getColumn(i + 1).width ?? null),
    rows: Array.from({ length: ws.rowCount }, (_, i) => ws.getRow(i + 1).height ?? null),
    cells: Array.from({ length: ws.rowCount }, (_, ri) => Array.from({ length: ws.columnCount }, (_, ci) => {
      const cell = ws.getCell(ri + 1, ci + 1);
      return stable({ address: cell.address, font: cell.font, fill: cell.fill, border: cell.border,
        alignment: cell.alignment, numFmt: cell.numFmt, protection: cell.protection });
    })),
    pageSetup: stable(ws.pageSetup),
  }));
}

export function productionTaskFixedTextManifest(workbook: ExcelJS.Workbook) {
  const main = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.main)!;
  const size = workbook.getWorksheet(PRODUCTION_TASK_SHEETS.size)!;
  return {
    main: Object.fromEntries(PRODUCTION_TASK_FIXED_CELLS.map(address => [address, stable(main.getCell(address).value)])),
    size: {
      A2: stable(size.getCell('A2').value), B2: stable(size.getCell('B2').value), C2: stable(size.getCell('C2').value),
      G2: stable(size.getCell('G2').value), H2: stable(size.getCell('H2').value),
    },
    fixedWarning: stable(main.getCell('L13').value),
    packagingFooter: stable(main.getCell('A24').value),
    mappedCellCount: Object.keys(PRODUCTION_TASK_CELLS).length,
  };
}
