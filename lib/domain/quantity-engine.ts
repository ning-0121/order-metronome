export type QuantityBasis =
  | 'PER_SET'
  | 'PER_COMPONENT'
  | 'PER_PIECE'
  | 'PER_ORDER'
  | 'PER_KG'
  | 'PER_METER'
  | 'PER_SQUARE_METER'
  | 'PER_YARD'
  | 'PER_PACK'
  | 'MANUAL_TOTAL';

export type MeasurementUnit = 'kg' | 'm' | 'sqm' | 'yard' | 'pack';

export type QuantitySource =
  | 'explicit_unit'
  | 'line_item_fallback'
  | 'legacy_piece'
  | 'ambiguous';

export type QuantityResolution =
  | {
    status: 'OK';
    quantity: number;
    source: 'commercial' | 'physical' | 'measurement' | 'fixed';
  }
  | {
    status: 'NEEDS_REVIEW';
    quantity: null;
    reason: string;
  }
  | {
    status: 'NEEDS_MEASUREMENT_QUANTITY';
    quantity: null;
    missingMeasurementLabel: string;
    measurementUnit: MeasurementUnit | null;
  };

export interface QuantityContext {
  physicalQuantity: number | null;
  commercialQuantity: number | null;
  commercialUnit: string | null;
  componentsPerCommercialUnit: number | null;
  measurementQuantity?: number | null;
  measurementUnit?: MeasurementUnit | null;
  source: QuantitySource;
  needsReview: boolean;
  reviewReason: string | null;
}

const SCALE = 1_000_000n;
const DEC_SCALE = 1_000_000;

function scaled(value: number | string): bigint {
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid decimal: ${raw}`);
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = (fraction + '000000').slice(0, 6);
  const result = BigInt(whole) * SCALE + BigInt(padded);
  return negative ? -result : result;
}

export function toDecimal(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveDecimal(value: number | string | null | undefined): number | null {
  const n = toDecimal(value);
  return n != null && n > 0 ? n : null;
}

function positiveInteger(value: number | string | null | undefined): number | null {
  const n = positiveDecimal(value);
  return n != null ? Math.round(n) : null;
}

export function multiplyDecimal(a: number | string, b: number | string): number {
  const result = (scaled(a) * scaled(b)) / SCALE;
  return Number(result) / DEC_SCALE;
}

export function divideDecimal(a: number | string, b: number | string): number {
  const dividend = scaled(a);
  const divisor = scaled(b);
  if (divisor === 0n) throw new Error('Division by zero');
  const numerator = dividend * SCALE;
  const half = divisor > 0n ? divisor / 2n : -((-divisor) / 2n);
  const result = (numerator + (numerator >= 0n ? half : -half)) / divisor;
  return Number(result) / DEC_SCALE;
}

export function formatDecimal(value: number | string | null | undefined, precision = 6): string {
  const n = toDecimal(value);
  if (n === null) return '';
  return n.toFixed(precision).replace(/\.?0+$/, '');
}

export function normalizeQuantityUnit(unit: string | null | undefined): string | null {
  const raw = String(unit ?? '').trim();
  return raw || null;
}

export function quantityComponentsForUnit(unit: string | null | undefined): number | null {
  const normalized = normalizeQuantityUnit(unit);
  if (!normalized) return null;
  if (/^件$|^pcs?$|^piece(?:s)?$/i.test(normalized)) return 1;
  if (/^三件套$/.test(normalized)) return 3;
  if (/^套$/.test(normalized)) return 2;
  const compact = normalized.replace(/\s+/g, '');
  const match = compact.match(/套[（(]?(\d+)\s*件[)）]?/);
  if (match) return Math.max(1, Number(match[1]) || 1);
  return null;
}

export function formatQuantityUnit(unit: string | null | undefined, componentsPerCommercialUnit: number | null): string {
  const normalized = normalizeQuantityUnit(unit);
  if (!normalized) return componentsPerCommercialUnit && componentsPerCommercialUnit > 1 ? '套' : '件';
  return normalized;
}

function uniquePositiveIntegers(values: Array<number | string | null | undefined>): number[] {
  const seen = new Set<number>();
  for (const value of values) {
    const n = positiveInteger(value);
    if (n != null) seen.add(n);
  }
  return [...seen];
}

export function deriveQuantityContext(input: {
  physicalQuantity?: number | string | null;
  quantityUnit?: string | null;
  componentsPerCommercialUnit?: number | string | null;
  lineItemMultipliers?: Array<number | string | null | undefined>;
  measurementQuantity?: number | string | null;
  measurementUnit?: MeasurementUnit | null;
}): QuantityContext {
  const physicalQuantity = positiveDecimal(input.physicalQuantity);
  const explicitUnit = normalizeQuantityUnit(input.quantityUnit);
  const explicitMultiplier = positiveInteger(input.componentsPerCommercialUnit);
  const inferredMultipliers = uniquePositiveIntegers(input.lineItemMultipliers || []);
  const fallbackMultiplier = inferredMultipliers.length === 1 ? inferredMultipliers[0] : null;
  const multiplier = explicitMultiplier || quantityComponentsForUnit(explicitUnit) || fallbackMultiplier || 1;
  const measurementQuantity = positiveDecimal(input.measurementQuantity);
  const measurementUnit = input.measurementUnit || null;

  let source: QuantitySource = 'legacy_piece';
  let needsReview = false;
  let reviewReason: string | null = null;

  if (explicitUnit) {
    source = 'explicit_unit';
  } else if (fallbackMultiplier && fallbackMultiplier > 1) {
    source = 'line_item_fallback';
    needsReview = true;
    reviewReason = `数量单位缺失，按明细推断为 ${fallbackMultiplier} 件/商业单位`;
  } else if (input.lineItemMultipliers && input.lineItemMultipliers.length > 0) {
    if (inferredMultipliers.length > 1) {
      source = 'ambiguous';
      needsReview = true;
      reviewReason = `数量单位缺失且明细倍率不一致：${inferredMultipliers.join(', ')}`;
    } else {
      source = 'legacy_piece';
      needsReview = true;
      reviewReason = '数量单位待确认，默认按件处理';
    }
  } else if (!explicitUnit) {
    needsReview = true;
    reviewReason = '数量单位待确认，默认按件处理';
  }

  const commercialQuantity = physicalQuantity == null
    ? null
    : (multiplier > 1 ? divideDecimal(physicalQuantity, multiplier) : physicalQuantity);

  return {
    physicalQuantity,
    commercialQuantity,
    commercialUnit: explicitUnit || (multiplier > 1 ? '套' : '件'),
    componentsPerCommercialUnit: multiplier,
    measurementQuantity,
    measurementUnit,
    source,
    needsReview: needsReview || !explicitUnit && multiplier > 1,
    reviewReason,
  };
}

function isMeasurementBasis(basis: QuantityBasis): basis is 'PER_KG' | 'PER_METER' | 'PER_SQUARE_METER' | 'PER_YARD' | 'PER_PACK' {
  return basis === 'PER_KG'
    || basis === 'PER_METER'
    || basis === 'PER_SQUARE_METER'
    || basis === 'PER_YARD'
    || basis === 'PER_PACK';
}

export function measurementLabelForBasis(basis?: QuantityBasis | null): string | null {
  switch (basis || 'PER_SET') {
    case 'PER_KG':
      return '公斤总需';
    case 'PER_METER':
      return '米数总需';
    case 'PER_SQUARE_METER':
      return '平方米总需';
    case 'PER_YARD':
      return '码数总需';
    case 'PER_PACK':
      return '采购包数';
    default:
      return null;
  }
}

export function resolveQuantityForBasis(
  ctx: QuantityContext,
  basis?: QuantityBasis | null,
): QuantityResolution {
  const resolvedBasis = basis || 'PER_SET';
  if (resolvedBasis === 'PER_ORDER' || resolvedBasis === 'MANUAL_TOTAL') {
    return { status: 'OK', quantity: 1, source: 'fixed' };
  }
  if (isMeasurementBasis(resolvedBasis)) {
    if (ctx.measurementQuantity != null && ctx.measurementQuantity > 0) {
      return { status: 'OK', quantity: ctx.measurementQuantity, source: 'measurement' };
    }
    return {
      status: 'NEEDS_MEASUREMENT_QUANTITY',
      quantity: null,
      missingMeasurementLabel: measurementLabelForBasis(resolvedBasis) || '数量基准',
      measurementUnit: ctx.measurementUnit || null,
    };
  }
  if (ctx.source === 'line_item_fallback' || ctx.source === 'ambiguous') {
    return {
      status: 'NEEDS_REVIEW',
      quantity: null,
      reason: ctx.reviewReason || '数量基准待确认',
    };
  }
  if (resolvedBasis === 'PER_PIECE' || resolvedBasis === 'PER_COMPONENT') {
    if (ctx.physicalQuantity == null) {
      return {
        status: 'NEEDS_REVIEW',
        quantity: null,
        reason: ctx.reviewReason || '数量基准待确认',
      };
    }
    return { status: 'OK', quantity: ctx.physicalQuantity, source: 'physical' };
  }
  if (ctx.commercialQuantity == null) {
    return {
      status: 'NEEDS_REVIEW',
      quantity: null,
      reason: ctx.reviewReason || '数量基准待确认',
    };
  }
  return { status: 'OK', quantity: ctx.commercialQuantity, source: 'commercial' };
}

export function quantityForBasis(
  ctx: QuantityContext,
  basis?: QuantityBasis | null,
): number | null {
  const resolved = resolveQuantityForBasis(ctx, basis);
  return resolved.status === 'OK' ? resolved.quantity : null;
}

export function formatQuantityDisplay(ctx: QuantityContext): string {
  const physical = ctx.physicalQuantity;
  const commercial = ctx.commercialQuantity;
  const unit = formatQuantityUnit(ctx.commercialUnit, ctx.componentsPerCommercialUnit);
  if (physical == null) return '数量待确认';
  let display: string;
  if (commercial == null) {
    display = `${formatDecimal(physical)}件`;
  } else if (commercial === physical || ctx.componentsPerCommercialUnit === 1) {
    display = `${formatDecimal(physical)}件`;
  } else {
    display = `${formatDecimal(commercial)}${unit}（折合${formatDecimal(physical)}件）`;
  }
  if (ctx.needsReview && !display.includes('数量基准待确认')) {
    display += '（数量基准待确认）';
  }
  return display;
}

export function quantityLabelForBasis(basis?: QuantityBasis | null): string {
  switch (basis || 'PER_SET') {
    case 'PER_COMPONENT':
      return '每部件';
    case 'PER_PIECE':
      return '每件';
    case 'PER_ORDER':
      return '整单';
    case 'PER_KG':
      return '每公斤';
    case 'PER_METER':
      return '每米';
    case 'PER_SQUARE_METER':
      return '每平方米';
    case 'PER_YARD':
      return '每码';
    case 'PER_PACK':
      return '每包';
    case 'MANUAL_TOTAL':
      return '手工总量';
    case 'PER_SET':
    default:
      return '每套';
  }
}

export function calculateRequirementFromContext(input: {
  consumption: number | string;
  quantity: QuantityContext;
  basis?: QuantityBasis | null;
  lossRatePct?: number | string | null;
  measurementQuantity?: number | string | null;
  measurementUnit?: MeasurementUnit | null;
}) {
  const basis = input.basis || 'PER_SET';
  const quantityCtx = {
    ...input.quantity,
    measurementQuantity: input.measurementQuantity !== undefined
      ? positiveDecimal(input.measurementQuantity)
      : input.quantity.measurementQuantity ?? null,
    measurementUnit: input.measurementUnit || input.quantity.measurementUnit || null,
  } as QuantityContext;
  const resolved = resolveQuantityForBasis(quantityCtx, basis);
  const consumption = positiveDecimal(input.consumption);
  const gross = resolved.status !== 'OK' || consumption == null
    ? null
    : multiplyDecimal(consumption, resolved.quantity);
  const loss = gross == null || !input.lossRatePct
    ? 0
    : multiplyDecimal(gross, Number(input.lossRatePct) / 100);
  return {
    basis,
    quantity: resolved.status === 'OK' ? resolved.quantity : null,
    status: resolved.status,
    missingMeasurementLabel: resolved.status === 'NEEDS_MEASUREMENT_QUANTITY' ? resolved.missingMeasurementLabel : null,
    measurementUnit: resolved.status === 'NEEDS_MEASUREMENT_QUANTITY' ? resolved.measurementUnit : null,
    gross,
    loss,
    totalWithLoss: gross == null ? null : gross + loss,
    needsReview: input.quantity.needsReview || resolved.status !== 'OK',
    reviewReason: input.quantity.reviewReason,
  };
}

export function deriveOrderQuantityContext(input: {
  physicalQuantity?: number | string | null;
  quantityUnit?: string | null;
  lineItemMultipliers?: Array<number | string | null | undefined>;
}): QuantityContext {
  return deriveQuantityContext(input);
}

/** Commercial/set quantity from a persisted line. Legacy `qty_pcs` may be physical
 * pieces when the line carries a kit multiplier; keep the conversion at this boundary. */
export function commercialQuantityFromLine(qty: number | string | null | undefined, multiplier: number | string | null | undefined): number {
  const q = positiveDecimal(qty) || 0;
  const m = positiveInteger(multiplier) || 1;
  return m > 1 ? divideDecimal(q, m) : q;
}
