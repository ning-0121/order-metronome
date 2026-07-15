export type ConsumptionBasis =
  | 'PER_SET'
  | 'PER_COMPONENT'
  | 'PER_PIECE'
  | 'PER_ORDER'
  | 'PER_KG'
  | 'PER_METER'
  | 'PER_PACK'
  | 'MANUAL_TOTAL';

const SCALE = 1_000_000;

function scaled(value: number | string): bigint {
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid decimal: ${raw}`);
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = (fraction + '000000').slice(0, 6);
  const result = BigInt(whole) * BigInt(SCALE) + BigInt(padded);
  return negative ? -result : result;
}

export function multiplyDecimal(a: number | string, b: number | string): number {
  const result = (scaled(a) * scaled(b)) / BigInt(SCALE);
  return Number(result) / SCALE;
}

export function addDecimals(...values: Array<number | string>): number {
  const result = values.reduce((sum, value) => sum + scaled(value), 0n);
  return Number(result) / SCALE;
}

/**
 * BOM consumption is per order set unless the line explicitly says PER_PIECE.
 * setMultiplier only converts sets to physical garments for genuinely per-piece lines.
 */
export function calculateRequirement(input: {
  consumption: number | string;
  orderSets: number | string;
  basis?: ConsumptionBasis | null;
  piecesPerSet?: number | string | null;
  lossRatePct?: number | string | null;
}) {
  const basis = input.basis || 'PER_SET';
  const quantity = basis === 'PER_PIECE'
    ? multiplyDecimal(input.orderSets, input.piecesPerSet || 1)
    : Number(input.orderSets);
  const gross = basis === 'PER_ORDER'
    ? Number(input.consumption)
    : multiplyDecimal(input.consumption, quantity);
  const loss = input.lossRatePct
    ? multiplyDecimal(gross, Number(input.lossRatePct) / 100)
    : 0;
  return { basis, quantity, gross, loss, totalWithLoss: gross + loss };
}
