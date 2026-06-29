// ============================================================
// Contract API v1 — scope 定义（系统对系统，不用人类角色）
// finance key → finance.read（可见成本/利润/价）
// araos  key → commercial.read（永不可见 QIMO 成本/margin）
// ============================================================

export type ContractScope = 'finance.read' | 'commercial.read';

export const SCOPES = {
  FINANCE_READ: 'finance.read' as ContractScope,
  COMMERCIAL_READ: 'commercial.read' as ContractScope,
};

/** finance.* scope 可见 financial / cost / margin；commercial(araos) 不可见。 */
export function canSeeFinancials(scope: ContractScope): boolean {
  return scope.startsWith('finance.');
}

/** 持有 scope 是否满足端点要求的 scope（0b 为精确相等）。 */
export function scopeSatisfies(have: ContractScope, need: ContractScope): boolean {
  return have === need;
}
