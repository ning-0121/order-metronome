import type { SizeChartDiagnostic, SizeChartParsedRow } from './types.ts';

const FULL_WIDTH = /[！＂＃＄％＆＇（）＊＋，－．／：；＜＝＞？＠［＼］＾＿｀｛｜｝～]/g;

const SIZE_ORDER = [
  'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL',
];

const SIZE_SYNONYMS = new Map([
  ['F', 'FREE'],
  ['FREE', 'FREE'],
  ['FREESIZE', 'FREE'],
  ['ONESIZE', 'FREE'],
  ['均码', 'FREE'],
  ['ONE SIZE', 'FREE'],
  ['FREE SIZE', 'FREE'],
  ['free', 'FREE'],
]);

const MEASUREMENT_SYNONYMS = new Map([
  ['部位', 'MEASUREMENT'],
  ['测量部位', 'MEASUREMENT'],
  ['尺寸部位', 'MEASUREMENT'],
  ['measurement', 'MEASUREMENT'],
  ['pointofmeasure', 'MEASUREMENT'],
  ['pom', 'MEASUREMENT'],
  ['size', 'SIZE_AXIS'],
  ['尺码', 'SIZE_AXIS'],
  ['规格', 'SPEC'],
  ['尺寸项目', 'MEASUREMENT'],
]);

export function normalizeText(value: unknown): string {
  if (value == null) return '';
  const raw = String(value).normalize('NFKC').replace(/\r\n?/g, '\n');
  return raw.trim().replace(/\u3000/g, ' ');
}

export function normalizeHeader(value: unknown): string {
  const text = normalizeText(value)
    .replace(FULL_WIDTH, '')
    .replace(/[()\[\]{}<>「」『』《》【】·、,.;:：，。！？!?'"`/\\|]/g, '')
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
  return MEASUREMENT_SYNONYMS.get(text) || text;
}

export function normalizeSizeLabel(value: unknown): string {
  const text = normalizeText(value)
    .replace(/\s+/g, '')
    .replace(/[()（）\[\]【】{}<>《》·、,.;:：，。！？!?'"`]/g, '')
    .replace(/[~～—–－]+/g, '-')
    .toUpperCase();
  if (!text) return '';
  const synonym = SIZE_SYNONYMS.get(text.toLowerCase()) || SIZE_SYNONYMS.get(text);
  if (synonym) return synonym;
  if (/^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}XL|\d{1,3})$/.test(text)) return text;
  return text;
}

export function isSizeLabel(value: unknown): boolean {
  return expandSizeLabels(value).length > 0;
}

export function expandSizeLabels(value: unknown): string[] {
  const text = normalizeSizeLabel(value);
  if (!text) return [];
  if (text === 'FREE') return ['FREE'];
  const range = text.match(/^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}XL|\d{1,3})-(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}XL|\d{1,3})$/);
  if (range) {
    const start = SIZE_ORDER.indexOf(range[1]);
    const end = SIZE_ORDER.indexOf(range[2]);
    if (start >= 0 && end >= 0 && start <= end) return SIZE_ORDER.slice(start, end + 1);
  }
  if (/^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}XL|\d{1,3})$/.test(text)) return [text];
  return [];
}

export function isMeasurementHeaderLabel(value: unknown): boolean {
  const normalized = normalizeHeader(value);
  return normalized === 'MEASUREMENT' || normalized === 'SPEC';
}

export function isSizeHeaderLabel(value: unknown): boolean {
  const normalized = normalizeHeader(value);
  return normalized === 'SIZE_AXIS';
}

export function extractLabelMeta(value: unknown): {
  label: string;
  unit: string | null;
  tolerance: string | null;
} {
  const text = normalizeText(value);
  const unitMatch = text.match(/[（(]\s*单位[:：]?\s*([^)）]+)[)）]/i)
    || text.match(/\b(cm|mm|kg|g|m|sqm|m2|yd|yard|pack|pcs|pc|oz|lb)\b/i);
  const toleranceMatch = text.match(/([±+-]\s*\d+(?:\.\d+)?(?:\s*cm|\s*mm|\s*%|))/i)
    || text.match(/[（(]\s*公差[:：]?\s*([^)）]+)[)）]/i);
  let label = text;
  label = label.replace(/[（(]\s*单位[:：]?[^)）]+[)）]/ig, '');
  label = label.replace(/[（(]\s*公差[:：]?[^)）]+[)）]/ig, '');
  label = label.replace(/\b(cm|mm|kg|g|m|sqm|m2|yd|yard|pack|pcs|pc|oz|lb)\b/ig, '');
  label = label.replace(/([±+-]\s*\d+(?:\.\d+)?(?:\s*cm|\s*mm|\s*%|))/ig, '');
  label = label.trim();
  return {
    label,
    unit: unitMatch ? normalizeText(Array.isArray(unitMatch) ? unitMatch[1] : unitMatch[1] ?? unitMatch[0]) : null,
    tolerance: toleranceMatch ? normalizeText(Array.isArray(toleranceMatch) ? toleranceMatch[1] : toleranceMatch[1] ?? toleranceMatch[0]) : null,
  };
}

export function valueToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && value !== null) {
    const maybe = value as { result?: unknown; text?: unknown; richText?: Array<{ text?: string }> };
    if (maybe.result != null) return valueToText(maybe.result);
    if (maybe.text != null) return normalizeText(maybe.text);
    if (Array.isArray(maybe.richText)) return maybe.richText.map((part) => part.text || '').join('').trim();
  }
  return normalizeText(value);
}

export function maybeNumber(value: unknown): string | number | null {
  const text = valueToText(value);
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : text;
}

export function blankRow(row: unknown[]): boolean {
  return row.every((cell) => valueToText(cell) === '');
}

export function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function rowToText(row: unknown[]): string[] {
  return row.map((cell) => valueToText(cell));
}

export function measurementNameFromCell(value: unknown): { measurement: string; unit: string | null; tolerance: string | null } {
  const meta = extractLabelMeta(value);
  return {
    measurement: meta.label || valueToText(value),
    unit: meta.unit,
    tolerance: meta.tolerance,
  };
}

export function isLikelyNoteRow(values: string[]): boolean {
  const joined = values.join('');
  return /备注|note|说明|注：|注$/i.test(joined);
}

export function scoreConfidence(base: number, adjustments: number[]): number {
  const total = [base, ...adjustments].reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(100, Math.round(total)));
}

export function makeDiagnosticsMessage(sheetName: string, code: string, message: string, severity: SizeChartDiagnostic['severity'] = 'info', rowNumber?: number | null, details?: Record<string, string | number | boolean | null>): SizeChartDiagnostic {
  return { sheetName, code, message, severity, rowNumber: rowNumber ?? null, details };
}

export function columnLetterFromIndex(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out || 'A';
}

export function normalizeRowsForOutput(rows: SizeChartParsedRow[]): SizeChartParsedRow[] {
  return rows.map((row) => {
    const values = Object.fromEntries(
      Object.entries(row.values).map(([key, value]) => [normalizeSizeLabel(key), value]),
    );
    return { ...row, values };
  });
}
