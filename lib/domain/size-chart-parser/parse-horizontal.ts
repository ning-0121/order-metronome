import type { SizeChartCandidate, SizeChartDiagnostic, SizeChartParsedRow } from './types.ts';
import {
  blankRow,
  columnLetterFromIndex,
  expandSizeLabels,
  extractLabelMeta,
  makeDiagnosticsMessage,
  measurementNameFromCell,
  maybeNumber,
  normalizeRowsForOutput,
  rowToText,
  scoreConfidence,
  valueToText,
  isLikelyNoteRow,
} from './normalize.ts';
import { bestCellIndex, detectRowSignal } from './detect-header.ts';

type SheetLike = {
  name: string;
  rows: unknown[][];
};

function splitHeaderTokens(value: string): string[] {
  return value
    .split(/[\/、|,，;；\s]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeOrdered(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function parseHorizontalTable(sheet: SheetLike, headerRow: number, ignoreRows: number[] = []): {
  status: 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';
  candidate?: SizeChartCandidate;
  rows: SizeChartParsedRow[];
  warnings: string[];
  errors: string[];
  diagnostics: SizeChartDiagnostic[];
  orientation: 'horizontal';
} {
  const diagnostics: SizeChartDiagnostic[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const header = sheet.rows[headerRow - 1] || [];
  const headerSignal = detectRowSignal(headerRow, header);
  const measurementIdx = bestCellIndex(headerSignal.measurementHeaderIndexes) ?? bestCellIndex(headerSignal.measurementLikeIndexes) ?? 0;

  const sizeCells = header.slice(measurementIdx + 1);
  const sizeLabels: string[] = [];
  const sizeColumns: number[] = [];

  sizeCells.forEach((cell, offset) => {
    const colIndex = measurementIdx + 1 + offset;
    const raw = valueToText(cell);
    if (!raw) return;
    const meta = extractLabelMeta(raw);
    const tokens = splitHeaderTokens(meta.label || raw);
    for (const token of tokens) {
      const expanded = expandSizeLabels(token);
      if (expanded.length > 0) {
        expanded.forEach((label, idx) => {
          sizeLabels.push(label);
          sizeColumns.push(colIndex + idx);
        });
        continue;
      }
      if (/^(单位|公差|备注|note|说明)$/i.test(token)) continue;
      if (/^(cm|mm|kg|g|m|sqm|m2|yd|yard|pack|pcs|pc|oz|lb)$/i.test(token)) continue;
    }
  });

  const uniqueSizeLabels = dedupeOrdered(sizeLabels);
  if (uniqueSizeLabels.length < 2) {
    diagnostics.push(
      makeDiagnosticsMessage(
        sheet.name,
        'NO_SIZE_COLUMNS',
        '找到了候选表头，但缺少可识别的尺码列',
        'error',
        headerRow,
        { measurementIdx, sizeColumnCount: sizeLabels.length },
      ),
    );
    return {
      status: 'FAILED',
      rows: [],
      warnings,
      errors: ['header_missing_size_columns'],
      diagnostics,
      orientation: 'horizontal',
    };
  }

  const rowBuckets = new Map<string, Record<string, string | number | null>>();
  const units = new Map<string, string | null>();
  const tolerances = new Map<string, string | null>();
  let parsedRows = 0;
  let lastMeaningfulRow = headerRow;

  for (let r = headerRow + 1; r <= sheet.rows.length; r++) {
    if (ignoreRows.includes(r)) continue;
    const row = sheet.rows[r - 1] || [];
    if (blankRow(row)) {
      if (parsedRows > 0 && r - lastMeaningfulRow > 2) break;
      continue;
    }

    const rowSignal = detectRowSignal(r, row);
    if (rowSignal.measurementHeaderIndexes.length > 0 && parsedRows > 0 && r > headerRow + 1) break;

    const rowTexts = rowToText(row);
    if (isLikelyNoteRow(rowTexts)) continue;

    const measurementCell = row.slice(0, Math.max(1, measurementIdx + 1)).map(valueToText).find(Boolean) || rowTexts[0];
    if (!measurementCell) continue;
    const { measurement, unit, tolerance } = measurementNameFromCell(measurementCell);
    if (!measurement) continue;

    const values: Record<string, string | number | null> = {};
    uniqueSizeLabels.forEach((label) => {
      const col = sizeColumns[sizeLabels.findIndex((candidate) => candidate === label)];
      if (col == null) return;
      values[label] = maybeNumber(row[col]);
    });
    if (Object.values(values).every((v) => v == null || v === '')) continue;

    rowBuckets.set(measurement, values);
    if (unit) units.set(measurement, unit);
    if (tolerance) tolerances.set(measurement, tolerance);
    parsedRows++;
    lastMeaningfulRow = r;
  }

  const rows: SizeChartParsedRow[] = [...rowBuckets.entries()].map(([measurement, values]) => ({
    measurement,
    values,
    unit: units.get(measurement) || null,
    tolerance: tolerances.get(measurement) || null,
  }));

  if (!rows.length) {
    diagnostics.push(makeDiagnosticsMessage(sheet.name, 'NO_DATA_ROWS', '识别到表头，但没有解析出有效数据行', 'error', headerRow));
    return {
      status: 'FAILED',
      rows: [],
      warnings,
      errors: ['no_data_rows'],
      diagnostics,
      orientation: 'horizontal',
    };
  }

  const confidence = scoreConfidence(55, [
    Math.min(18, uniqueSizeLabels.length * 2),
    Math.min(12, rows.length * 2),
    headerSignal.measurementHeaderIndexes.length ? 10 : 0,
    headerSignal.sizeLabelIndexes.length ? 8 : 0,
  ]);
  if (rows.some((row) => Object.values(row.values).some((v) => v == null))) warnings.push('存在空白单元格，建议人工复核');
  if (sizeLabels.length !== uniqueSizeLabels.length) warnings.push('检测到重复尺码列，已按首次出现顺序保留');

  return {
    status: confidence >= 80 && warnings.length === 0 ? 'PARSED' : 'NEEDS_REVIEW',
    candidate: {
      sheetName: sheet.name,
      headerRow,
      orientation: 'horizontal',
      sizeLabels: uniqueSizeLabels,
      measurementLabels: rows.map((row) => row.measurement),
      tableRange: `A${headerRow}:${columnLetterFromIndex(Math.max(1, Math.max(...sizeColumns) + 1))}${lastMeaningfulRow}`,
      score: confidence,
      confidence,
      diagnostics,
    },
    rows: normalizeRowsForOutput(rows),
    warnings,
    errors,
    diagnostics,
    orientation: 'horizontal',
  };
}
