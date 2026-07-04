/**
 * 采购 P1 — 纯逻辑（供应商字段分工 + 采购单底价屏蔽）
 *
 * 字段级权限与价格可见性都在这里做成纯函数，action 层调用、可单测。
 * 建议价 = price_baseline（业务可见）；大货底价 = unit_price（业务隐藏）。
 */

export const SUPPLIER_BUSINESS_FIELDS = ['name', 'address', 'phone', 'contact_name', 'main_category'] as const;
export const SUPPLIER_FINANCE_FIELDS = ['payment_method', 'net_days', 'bank_info', 'tax_id'] as const;

/** 只保留该角色可编辑的供应商字段（业务字段 / 财务字段分工）。 */
export function pickEditableSupplierFields(
  input: Record<string, unknown>,
  canBasic: boolean,
  canFinance: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (canBasic) for (const f of SUPPLIER_BUSINESS_FIELDS) if (f in input) out[f] = (input as any)[f];
  if (canFinance) for (const f of SUPPLIER_FINANCE_FIELDS) if (f in input) out[f] = (input as any)[f];
  return out;
}

/**
 * 屏蔽大货采购底价（unit_price）—— 非 CAN_SEE_PROCUREMENT_FLOOR 角色（如业务）
 * 拿到的采购单行里**根本没有 unit_price 字段**（server 端剥离，非 UI 隐藏）。
 * 采购建议价 price_baseline 保留。
 */
export function maskFloorForLines<T extends Record<string, unknown>>(rows: T[], canSeeFloor: boolean): T[] {
  if (canSeeFloor) return rows;
  return rows.map((r) => {
    const { unit_price, ordered_amount, difference_amount, ...rest } = r as any;
    return rest as T; // 连派生金额(含 unit_price)一并剥离，防反推底价
  });
}

/**
 * 屏蔽供应商财务字段（付款方式/账期/银行/税号）—— 非 CAN_EDIT_SUPPLIER_FINANCE
 * 角色(如业务/生产/物流)拿到的供应商对象里根本没有这些字段(server 端剥离)。
 * 接受单个对象或数组;null/undefined 原样返回。
 */
export function maskSupplierFinance<T extends Record<string, unknown> | null | undefined>(
  input: T,
  canSeeFinance: boolean,
): T {
  if (canSeeFinance || input == null) return input;
  const strip = (r: any) => {
    if (r == null || typeof r !== 'object') return r;
    const { payment_method, net_days, bank_info, tax_id, ...rest } = r;
    return rest;
  };
  return (Array.isArray(input) ? (input as any[]).map(strip) : strip(input)) as T;
}
