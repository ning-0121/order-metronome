import type { SizeChartCandidate, SizeChartDiagnostic, SizeChartParsedRow } from './types.ts';
import {
  blankRow,
  columnLetterFromIndex,
  expandSizeLabels,
  extractLabelMeta,
  isLikelyNoteRow,
  makeDiagnosticsMessage,
  maybeNumber,
  normalizeRowsForOutput,
  rowToText,
  scoreConfidence,
  valueToText,
} from './normalize.ts';
import { bestCellIndex, detectRowSignal } from './detect-header.ts';

type SheetLike = {
  name: string;
  rows: unknown[][];
};

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

export function parseVerticalTable(sheet: SheetLike, headerRow: number, ignoreRows: number[] = []): {
  status: 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';
  candidate?: SizeChartCandidate;
  rows: SizeChartParsedRow[];
  warnings: string[];
  errors: string[];
  diagnostics: SizeChartDiagnostic[];
  orientation: 'vertical';
} {
  const diagnostics: SizeChartDiagnostic[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const header = sheet.rows[headerRow - 1] || [];
  const headerSignal = detectRowSignal(headerRow, header);
  const sizeIdx = bestCellIndex(headerSignal.sizeHeaderIndexes) ?? 0;

  const measurementColumns = header
    .map((cell, idx) => ({ cell, idx }))
    .slice(sizeIdx + 1)
    .filter(({ cell }) => valueToText(cell) !== '')
    .map(({ cell, idx }) => ({ idx, meta: extractLabelMeta(cell) }))
    .filter(({ meta }) => meta.label);

  const measurementLabels = dedupeOrdered(measurementColumns.map((c) => c.meta.label));
  if (measurementLabels.length < 2) {
    diagnostics.push(
      makeDiagnosticsMessage(
        sheet.name,
        'NO_MEASUREMENT_COLUMNS',
        '找到了尺码列，但没有可识别的测量部位列',
        'error',
        headerRow,
        { sizeIdx, measurementColumnCount: measurementColumns.length },
      ),
    );
    return {
      status: 'FAILED',
      rows: [],
      warnings,
      errors: ['header_missing_measurement_columns'],
      diagnostics,
      orientation: 'vertical',
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
    if (rowSignal.sizeHeaderIndexes.length > 0 && parsedRows > 0 && r > headerRow + 1) break;

    const rowTexts = rowToText(row);
    if (isLikelyNoteRow(rowTexts)) continue;

    const rawSize = valueToText(row[sizeIdx]);
    const expandedSizes = expandSizeLabels(rawSize);
    if (!expandedSizes.length) continue;

    const measurementValues: Record<string, string | number | null> = {};
    for (const { idx, meta } of measurementColumns) {
      const measurement = meta.label;
      measurementValues[measurement] = maybeNumber(row[idx]);
      if (meta.unit && !units.has(measurement)) units.set(measurement, meta.unit);
      if (meta.tolerance && !tolerances.has(measurement)) tolerances.set(measurement, meta.tolerance);
    }
    if (Object.values(measurementValues).every((v) => v == null || v === '')) continue;

    for (const sizeLabel of expandedSizes) {
      for (const [measurement, value] of Object.entries(measurementValues)) {
        const bucket = rowBuckets.get(measurement) || {};
        bucket[sizeLabel] = value;
        rowBuckets.set(measurement, bucket);
      }
    }

    if (expandedSizes.length > 1) warnings.push(`检测到尺码范围 ${rawSize}，已展开为多个尺码标签`);
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
      orientation: 'vertical',
    };
  }

  const confidence = scoreConfidence(55, [
    Math.min(18, measurementLabels.length * 2),
    Math.min(12, rows.length * 2),
    headerSignal.sizeHeaderIndexes.length ? 10 : 0,
    headerSignal.measurementLikeIndexes.length ? 8 : 0,
  ]);
  if (rows.some((row) => Object.values(row.values).some((v) => v == null))) warnings.push('存在空白单元格，建议人工复核');

  return {
    status: confidence >= 80 && warnings.length === 0 ? 'PARSED' : 'NEEDS_REVIEW',
    candidate: {
      sheetName: sheet.name,
      headerRow,
      orientation: 'vertical',
      sizeLabels: dedupeOrdered(rows.flatMap((row) => Object.keys(row.values))),
      measurementLabels,
      tableRange: `A${headerRow}:${columnLetterFromIndex(Math.max(1, Math.max(sizeIdx + 1, measurementColumns.reduce((max, c) => Math.max(max, c.idx + 1), 1))))}${lastMeaningfulRow}`,
      score: confidence,
      confidence,
      diagnostics,
    },
    rows: normalizeRowsForOutput(rows),
    warnings,
    errors,
    diagnostics,
    orientation: 'vertical',
  };
}
