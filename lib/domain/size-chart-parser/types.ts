export type SizeChartStatus = 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';
export type SizeChartOrientation = 'horizontal' | 'vertical';

export interface SizeChartParseOptions {
  worksheetName?: string | null;
  headerRow?: number | null;
  orientation?: SizeChartOrientation | null;
  sizeAxis?: 'row' | 'column' | null;
  measurementAxis?: 'row' | 'column' | null;
  ignoreRows?: number[] | null;
}

export interface SizeChartParsedRow {
  measurement: string;
  values: Record<string, string | number | null>;
  unit?: string | null;
  tolerance?: string | null;
}

export interface SizeChartDiagnostic {
  sheetName: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  rowNumber?: number | null;
  details?: Record<string, string | number | boolean | null>;
}

export interface SizeChartCandidate {
  sheetName: string;
  headerRow: number;
  orientation: SizeChartOrientation;
  sizeLabels: string[];
  measurementLabels: string[];
  tableRange: string;
  score: number;
  confidence: number;
  diagnostics: SizeChartDiagnostic[];
}

export interface SizeChartParseResult {
  status: SizeChartStatus;
  worksheetName: string | null;
  tableRange: string | null;
  orientation: SizeChartOrientation | null;
  headerRow: number | null;
  sizeLabels: string[];
  measurementLabels: string[];
  rows: SizeChartParsedRow[];
  units: Record<string, string | null>;
  tolerances: Record<string, string | null>;
  confidence: number;
  warnings: string[];
  errors: string[];
  diagnostics: SizeChartDiagnostic[];
  candidates: SizeChartCandidate[];
  parserVersion: string;
}
