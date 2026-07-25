import { describe, it, expect } from 'vitest';
import { hasRoleInGroup } from '@/lib/domain/roles';

// 价格红线(根因5):客户价看 CAN_SEE_FINANCIALS,进价成本看 CAN_SEE_PROCUREMENT_FLOOR|FINANCIALS。
const canSeeCustomerPrice = (r: string) => hasRoleInGroup([r], 'CAN_SEE_FINANCIALS');
const canSeeCost = (r: string) =>
  hasRoleInGroup([r], 'CAN_SEE_PROCUREMENT_FLOOR') || hasRoleInGroup([r], 'CAN_SEE_FINANCIALS');

describe('价格可见性红线', () => {
  // [角色, 可见客户价, 可见进价成本]
  const cases: Array<[string, boolean, boolean]> = [
    ['admin', true, true],
    ['finance', true, true],
    ['sales', true, true],            // 业务开发:财务口径,两者可见
    ['sales_manager', true, true],
    ['order_manager', true, true],
    ['procurement', false, true],     // 采购:看成本,不看客户售价
    ['procurement_manager', false, true],
    // 以下操作类角色:客户价 + 成本 双双不可见(这是本轮泄露修复的核心)
    ['production', false, false],
    ['qc', false, false],
    ['merchandiser', false, false],
    ['logistics', false, false],
    ['admin_assistant', false, false],
    ['production_manager', false, false],
  ];

  for (const [role, price, cost] of cases) {
    it(`${role}:客户价=${price} 成本=${cost}`, () => {
      expect(canSeeCustomerPrice(role)).toBe(price);
      expect(canSeeCost(role)).toBe(cost);
    });
  }

  it('生产/QC/物流 绝不可见客户成交价(红线关键断言)', () => {
    for (const r of ['production', 'qc', 'logistics', 'merchandiser', 'admin_assistant']) {
      expect(canSeeCustomerPrice(r), `${r} 不该看到客户价`).toBe(false);
      expect(canSeeCost(r), `${r} 不该看到进价成本`).toBe(false);
    }
  });

  it('未知角色一律不可见', () => {
    expect(canSeeCustomerPrice('nobody')).toBe(false);
    expect(canSeeCost('nobody')).toBe(false);
  });
});
