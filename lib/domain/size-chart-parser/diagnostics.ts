import type { SizeChartCandidate, SizeChartDiagnostic } from './types.ts';

export function buildFailureDiagnostics(sheets: Array<{ name: string; reason: string; candidates?: number }>, extra: SizeChartDiagnostic[] = []): SizeChartDiagnostic[] {
  const diagnostics: SizeChartDiagnostic[] = sheets.map((sheet) => ({
    sheetName: sheet.name,
    severity: 'warning',
    code: 'SHEET_SCAN',
    message: sheet.reason,
    details: sheet.candidates != null ? { candidates: sheet.candidates } : undefined,
  }));
  return [...diagnostics, ...extra];
}

export function candidateSummary(candidate: SizeChartCandidate): string {
  return `${candidate.sheetName}#${candidate.headerRow} ${candidate.orientation} ${candidate.sizeLabels.length}码/${candidate.measurementLabels.length}部位`;
}
