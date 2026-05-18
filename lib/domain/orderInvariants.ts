/**
 * Order Invariants — 订单数据完整性的物理约束 SSOT
 *
 * 同 lib/domain/orderDates.ts（日期链）配套使用。
 * 一切违反"物理事实"的写库操作必须在这里被拦截。
 */

// ─────────────────────────────────────────────────────────────
// 1. 数量守恒：分批出货时，各批次数量之和必须 = 订单总数量
// ─────────────────────────────────────────────────────────────

export interface QuantityConservationInput {
  orderQuantity: number | null | undefined;
  batches: { quantity: number | null | undefined }[];
  /** 允许偏差（默认 0 — 严格相等）。某些场景如尾差可设 1-2 件 */
  toleranceUnits?: number;
}

export interface QuantityConservationResult {
  ok: boolean;
  orderTotal: number;
  batchSum: number;
  diff: number;
  message?: string;
}

export function validateQuantityConservation(input: QuantityConservationInput): QuantityConservationResult {
  const orderTotal = Number(input.orderQuantity || 0);
  const batchSum = input.batches.reduce((s, b) => s + Number(b.quantity || 0), 0);
  const diff = batchSum - orderTotal;
  const tolerance = input.toleranceUnits ?? 0;

  if (orderTotal === 0) {
    return {
      ok: false,
      orderTotal,
      batchSum,
      diff,
      message: '订单总数量为 0，无法分批出货',
    };
  }

  if (Math.abs(diff) > tolerance) {
    return {
      ok: false,
      orderTotal,
      batchSum,
      diff,
      message: `批次数量之和（${batchSum} 件）与订单总数量（${orderTotal} 件）不一致：差 ${diff > 0 ? '+' : ''}${diff} 件。请调整各批次数量或确认订单总数量。`,
    };
  }

  return { ok: true, orderTotal, batchSum, diff };
}

// ─────────────────────────────────────────────────────────────
// 2. 金额守恒：定金 + 尾款 = 销售总额（容许小数浮点误差 0.01）
// ─────────────────────────────────────────────────────────────

export interface AmountConservationInput {
  saleTotal: number | null | undefined;
  depositAmount: number | null | undefined;
  balanceAmount: number | null | undefined;
  /** 允许的最大绝对偏差（默认 0.01 — 浮点精度容忍）*/
  toleranceCny?: number;
}

export interface AmountConservationResult {
  ok: boolean;
  saleTotal: number;
  depositPlusBalance: number;
  diff: number;
  message?: string;
}

export function validateAmountConservation(input: AmountConservationInput): AmountConservationResult {
  const saleTotal = Number(input.saleTotal || 0);
  const deposit = Number(input.depositAmount || 0);
  const balance = Number(input.balanceAmount || 0);
  const sum = deposit + balance;
  const diff = sum - saleTotal;
  const tolerance = input.toleranceCny ?? 0.01;

  // 全部为 0 → 跳过（尚未录入）
  if (saleTotal === 0 && deposit === 0 && balance === 0) {
    return { ok: true, saleTotal, depositPlusBalance: sum, diff: 0 };
  }

  // 部分录入（如只录销售额）→ 跳过校验（等录全再算）
  if (saleTotal === 0 || (deposit === 0 && balance === 0)) {
    return { ok: true, saleTotal, depositPlusBalance: sum, diff: 0 };
  }

  if (Math.abs(diff) > tolerance) {
    return {
      ok: false,
      saleTotal,
      depositPlusBalance: sum,
      diff,
      message: `金额对不上：定金（${deposit.toFixed(2)}）+ 尾款（${balance.toFixed(2)}）= ${sum.toFixed(2)}，与销售总额（${saleTotal.toFixed(2)}）相差 ${diff > 0 ? '+' : ''}${diff.toFixed(2)}。请调整定金或尾款金额。`,
    };
  }

  return { ok: true, saleTotal, depositPlusBalance: sum, diff };
}
