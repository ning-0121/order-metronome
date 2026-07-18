import { expandSizeLabels, isMeasurementHeaderLabel, isSizeHeaderLabel, normalizeText, rowToText, isLikelyNoteRow } from './normalize.ts';

export interface RowSignal {
  rowNumber: number;
  measurementHeaderIndexes: number[];
  sizeHeaderIndexes: number[];
  sizeLabelIndexes: number[];
  measurementLikeIndexes: number[];
  sizeLabels: string[];
  measurementLabels: string[];
  score: number;
  noteLike: boolean;
}

const MEASUREMENT_LIKE = /^(胸围|腰围|臀围|肩宽|袖长|衣长|领围|前胸|后背|length|width|height|depth|waist|hip|rise|inseam|outseam|bust|sleeve|shoulder|neck|cuff|thigh|leg|circumference|measurement|measure)$/i;

export function detectRowSignal(rowNumber: number, row: unknown[]): RowSignal {
  const measurementHeaderIndexes: number[] = [];
  const sizeHeaderIndexes: number[] = [];
  const sizeLabelIndexes: number[] = [];
  const measurementLikeIndexes: number[] = [];
  const sizeLabels: string[] = [];
  const measurementLabels: string[] = [];
  let score = 0;
  const texts = rowToText(row);
  const noteLike = isLikelyNoteRow(texts);

  texts.forEach((text, index) => {
    if (!text) return;
    if (isMeasurementHeaderLabel(text)) {
      measurementHeaderIndexes.push(index);
      score += 30;
      return;
    }
    if (isSizeHeaderLabel(text)) {
      sizeHeaderIndexes.push(index);
      score += 30;
      return;
    }
    const expanded = expandSizeLabels(text);
    if (expanded.length > 0) {
      sizeLabelIndexes.push(index);
      expanded.forEach((item) => sizeLabels.push(item));
      score += 8;
      return;
    }
    if (MEASUREMENT_LIKE.test(normalizeText(text))) {
      measurementLikeIndexes.push(index);
      measurementLabels.push(text);
      score += 4;
    }
  });

  if (sizeLabels.length >= 2) score += 12;
  if (measurementHeaderIndexes.length > 0 && (sizeLabels.length >= 2 || sizeHeaderIndexes.length > 0)) score += 10;
  if (measurementLikeIndexes.length >= 2) score += 8;
  if (noteLike) score -= 12;

  return {
    rowNumber,
    measurementHeaderIndexes,
    sizeHeaderIndexes,
    sizeLabelIndexes,
    measurementLikeIndexes,
    sizeLabels,
    measurementLabels,
    score,
    noteLike,
  };
}

export function detectHorizontalHeader(signal: RowSignal): boolean {
  return signal.measurementHeaderIndexes.length > 0 && signal.sizeLabels.length >= 2;
}

export function detectVerticalHeader(signal: RowSignal): boolean {
  return signal.sizeHeaderIndexes.length > 0 && signal.measurementLikeIndexes.length >= 2;
}

export function headerIsLikely(signal: RowSignal): boolean {
  return detectHorizontalHeader(signal) || detectVerticalHeader(signal);
}

export function bestCellIndex(indexes: number[]): number | null {
  return indexes.length ? Math.min(...indexes) : null;
}
