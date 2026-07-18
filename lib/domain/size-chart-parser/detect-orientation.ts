import type { SizeChartOrientation } from './types.ts';
import { detectHorizontalHeader, detectVerticalHeader, type RowSignal } from './detect-header.ts';

export function detectOrientation(signal: RowSignal): { orientation: SizeChartOrientation | null; confidence: number; reason: string } {
  const horizontal = detectHorizontalHeader(signal);
  const vertical = detectVerticalHeader(signal);
  if (horizontal && !vertical) return { orientation: 'horizontal', confidence: Math.min(95, signal.score), reason: 'recognized horizontal header' };
  if (vertical && !horizontal) return { orientation: 'vertical', confidence: Math.min(95, signal.score), reason: 'recognized vertical header' };
  if (horizontal && vertical) return { orientation: 'horizontal', confidence: Math.max(65, signal.score - 10), reason: 'ambiguous header: both orientations possible' };
  return { orientation: null, confidence: Math.max(0, signal.score - 20), reason: 'no clear orientation' };
}
