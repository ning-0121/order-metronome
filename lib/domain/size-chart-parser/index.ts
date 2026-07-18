import { createRequire } from 'node:module';
import type { SizeChartCandidate, SizeChartDiagnostic, SizeChartOrientation, SizeChartParseOptions, SizeChartParseResult, SizeChartParsedRow } from './types.ts';
import { blankRow, makeDiagnosticsMessage } from './normalize.ts';
import { buildFailureDiagnostics } from './diagnostics.ts';
import { detectRowSignal, headerIsLikely } from './detect-header.ts';
import { detectOrientation } from './detect-orientation.ts';
import { parseHorizontalTable } from './parse-horizontal.ts';
import { parseVerticalTable } from './parse-vertical.ts';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs') as typeof import('exceljs');

const PARSER_VERSION = 'size-chart-v2-2026-07-18';

type SheetSnapshot = { name: string; rows: unknown[][] };

function snapshotSheet(sheet: ExcelJS.Worksheet): SheetSnapshot {
  const rows: unknown[][] = [];
  const maxRow = Math.min(sheet.rowCount || 0, 200);
  for (let rowNo = 1; rowNo <= maxRow; rowNo++) {
    const row = sheet.getRow(rowNo);
    const cols: unknown[] = [];
    const maxCol = Math.min(sheet.actualColumnCount || sheet.columnCount || 0, 60);
    for (let col = 1; col <= maxCol; col++) {
      cols.push(row.getCell(col).value ?? null);
    }
    rows.push(cols);
  }
  return { name: sheet.name, rows };
}

function summarizeSheet(sheet: SheetSnapshot): { candidates: number; reason: string } {
  let candidates = 0;
  let sawMeasurementHeaderNoSizes = false;
  let sawSizeHeaderNoMeasurements = false;
  for (let i = 0; i < sheet.rows.length; i++) {
    const signal = detectRowSignal(i + 1, sheet.rows[i]);
    if (signal.measurementHeaderIndexes.length > 0 && signal.sizeLabels.length < 2) sawMeasurementHeaderNoSizes = true;
    if (signal.sizeHeaderIndexes.length > 0 && signal.measurementLikeIndexes.length < 2) sawSizeHeaderNoMeasurements = true;
    if (headerIsLikely(signal)) candidates++;
  }
  if (candidates === 0) {
    if (sawMeasurementHeaderNoSizes) return { candidates, reason: '找到了表头但没有可识别的尺码列' };
    if (sawSizeHeaderNoMeasurements) return { candidates, reason: '找到了尺码列但没有可识别的测量部位列' };
    return { candidates, reason: '未找到可识别尺码表头或尺码列' };
  }
  return { candidates, reason: `找到 ${candidates} 个候选表头` };
}

function scanSheetCandidates(sheet: SheetSnapshot): SizeChartCandidate[] {
  const candidates: SizeChartCandidate[] = [];
  for (let rowNo = 1; rowNo <= sheet.rows.length; rowNo++) {
    const row = sheet.rows[rowNo - 1] || [];
    if (blankRow(row)) continue;
    const signal = detectRowSignal(rowNo, row);
    const orientation = detectOrientation(signal);
    if (!orientation.orientation) continue;
    const parsed = orientation.orientation === 'vertical'
      ? parseVerticalTable(sheet, rowNo)
      : parseHorizontalTable(sheet, rowNo);
    if (parsed.candidate) candidates.push(parsed.candidate);
  }
  return candidates;
}

function chooseCandidate(candidates: SizeChartCandidate[]): SizeChartCandidate | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  return sorted[0];
}

function candidateDiagnostics(candidates: SizeChartCandidate[]): SizeChartDiagnostic[] {
  return candidates.map((candidate) => ({
    sheetName: candidate.sheetName,
    severity: 'info',
    code: 'CANDIDATE_FOUND',
    message: `${candidate.orientation} ${candidate.headerRow} 行可解析`,
    rowNumber: candidate.headerRow,
    details: {
      confidence: candidate.confidence,
      sizeCount: candidate.sizeLabels.length,
      measurementCount: candidate.measurementLabels.length,
    },
  }));
}

function parseWithHints(sheet: SheetSnapshot, options: SizeChartParseOptions): SizeChartParseResult {
  const orientation = options.orientation
    || (options.sizeAxis === 'row' || options.measurementAxis === 'column' ? 'vertical' : null)
    || (options.sizeAxis === 'column' || options.measurementAxis === 'row' ? 'horizontal' : null)
    || 'horizontal';
  const ignoreRows = options.ignoreRows || [];
  const hintedHeaderRow = options.headerRow || 0;
  if (hintedHeaderRow > 0) {
    const parse = orientation === 'vertical'
      ? parseVerticalTable(sheet, hintedHeaderRow, ignoreRows)
      : parseHorizontalTable(sheet, hintedHeaderRow, ignoreRows);
    return finalize(sheet.name, parse, parse.candidate ? [parse.candidate] : [], []);
  }

  const candidates = scanSheetCandidates(sheet);
  const chosen = chooseCandidate(candidates);
  if (!chosen) {
    return {
      status: 'FAILED',
      worksheetName: sheet.name,
      tableRange: null,
      orientation: null,
      headerRow: null,
      sizeLabels: [],
      measurementLabels: [],
      rows: [],
      units: {},
      tolerances: {},
      confidence: 0,
      warnings: [],
      errors: ['NO_RECOGNIZABLE_TABLE'],
      diagnostics: buildFailureDiagnostics([{ name: sheet.name, reason: '未找到可识别尺码表头或尺码列', candidates: 0 }]),
      candidates: [],
      parserVersion: PARSER_VERSION,
    };
  }
  const parser = chosen.orientation === 'vertical' ? parseVerticalTable : parseHorizontalTable;
  const parsed = parser(sheet, chosen.headerRow, ignoreRows);
  return finalize(sheet.name, parsed, candidates, []);
}

function finalize(
  worksheetName: string | null,
  parsed: {
    status: 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';
    rows: SizeChartParsedRow[];
    warnings: string[];
    errors: string[];
    diagnostics: SizeChartDiagnostic[];
    candidate?: SizeChartCandidate;
    orientation: SizeChartOrientation;
  },
  candidates: SizeChartCandidate[],
  sheetDiagnostics: SizeChartDiagnostic[],
): SizeChartParseResult {
  const chosen = parsed.candidate ?? null;
  const warnings = [...parsed.warnings];
  const errors = [...parsed.errors];
  const diagnostics = [...sheetDiagnostics, ...parsed.diagnostics];
  if (!chosen) errors.push('NO_CANDIDATE');
  if (candidates.length > 1) warnings.push('检测到多个候选表，需要人工选择工作表或表头行');
  const confidence = chosen?.confidence ?? (parsed.status === 'FAILED' ? 0 : 75);
  return {
    status: parsed.status,
    worksheetName,
    tableRange: chosen?.tableRange ?? null,
    orientation: chosen?.orientation ?? parsed.orientation ?? null,
    headerRow: chosen?.headerRow ?? null,
    sizeLabels: chosen?.sizeLabels ?? [],
    measurementLabels: chosen?.measurementLabels ?? [],
    rows: parsed.rows,
    units: Object.fromEntries(parsed.rows.map((row) => [row.measurement, row.unit ?? null])),
    tolerances: Object.fromEntries(parsed.rows.map((row) => [row.measurement, row.tolerance ?? null])),
    confidence,
    warnings,
    errors,
    diagnostics,
    candidates,
    parserVersion: PARSER_VERSION,
  };
}

export async function parseSizeChartWorkbook(bytes: ArrayBuffer, options: SizeChartParseOptions = {}): Promise<SizeChartParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheets = workbook.worksheets.map(snapshotSheet);
  if (!sheets.length) {
    return {
      status: 'FAILED',
      worksheetName: null,
      tableRange: null,
      orientation: null,
      headerRow: null,
      sizeLabels: [],
      measurementLabels: [],
      rows: [],
      units: {},
      tolerances: {},
      confidence: 0,
      warnings: [],
      errors: ['EMPTY_WORKBOOK'],
      diagnostics: [makeDiagnosticsMessage('(workbook)', 'EMPTY_WORKBOOK', '工作簿为空或无法读取', 'error')],
      candidates: [],
      parserVersion: PARSER_VERSION,
    };
  }

  if (options.worksheetName || options.headerRow || options.orientation || options.sizeAxis || options.measurementAxis) {
    const sheet = sheets.find((s) => !options.worksheetName || s.name === options.worksheetName) || sheets[0];
    const parsed = parseWithHints(sheet, options);
    return { ...parsed, worksheetName: sheet.name };
  }

  const sheetSummaries = sheets.map((sheet) => ({ sheet, ...summarizeSheet(sheet) }));
  const diagnostics: SizeChartDiagnostic[] = sheetSummaries.map((summary) => ({
    sheetName: summary.sheet.name,
    severity: summary.candidates > 0 ? 'info' : 'warning',
    code: 'SHEET_SCAN',
    message: summary.reason,
    details: { candidates: summary.candidates },
  }));

  const candidates = sheets.flatMap(scanSheetCandidates);

  const chosen = chooseCandidate(candidates);
  if (!chosen) {
    return {
      status: 'FAILED',
      worksheetName: null,
      tableRange: null,
      orientation: null,
      headerRow: null,
      sizeLabels: [],
      measurementLabels: [],
      rows: [],
      units: {},
      tolerances: {},
      confidence: 0,
      warnings: [],
      errors: ['NO_RECOGNIZABLE_TABLE'],
      diagnostics: buildFailureDiagnostics(sheetSummaries.map((sheet) => ({ name: sheet.sheet.name, reason: sheet.reason, candidates: sheet.candidates }))),
      candidates: [],
      parserVersion: PARSER_VERSION,
    };
  }

  const parser = chosen.orientation === 'vertical' ? parseVerticalTable : parseHorizontalTable;
  const sheet = sheets.find((s) => s.name === chosen.sheetName) || sheets[0];
  const parsed = parser(sheet, chosen.headerRow);
  const result = finalize(sheet.name, parsed, candidates, diagnostics);
  if (candidates.length > 1) {
    result.status = result.status === 'FAILED' ? 'FAILED' : 'NEEDS_REVIEW';
    result.warnings = [...result.warnings, '检测到多个候选表，需要人工选择工作表或表头行'];
    result.diagnostics = [...result.diagnostics, ...candidateDiagnostics(candidates)];
  }
  if (result.status === 'PARSED' && result.confidence < 80) result.status = 'NEEDS_REVIEW';
  return result;
}

export type {
  SizeChartCandidate,
  SizeChartDiagnostic,
  SizeChartOrientation,
  SizeChartParseOptions,
  SizeChartParseResult,
  SizeChartParsedRow,
  SizeChartStatus,
} from './types';
