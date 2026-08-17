/**
 * 延期审批链空值自愈(2026-08-17 实发:CEO 点批准「没反应」)。
 *
 * 根因:整单延期创建路径 `orderDelayPayload` 从来没写 approval_chain(DB 默认 []),
 * 而 approveDeferralStep 第一行 `chain.length===0 → return { error }` ——
 * 什么都不写、计数不变,用户看到的就是点了没反应。
 * 实测 112 条延期里 98 条空链;历史那 88 条是从订单页旧入口批掉的,所以一直没暴露。
 */
import { describe, it, expect } from 'vitest';
import { deferralChainFor, canActOnDeferralStep, DEFERRAL_ROUTING } from '@/lib/domain/deferral-routing';

describe('deferralChainFor 永不返回空链', () => {
  it('已配置角色 → 对应链', () => {
    expect(deferralChainFor('procurement')).toEqual(['order_manager']);
    expect(deferralChainFor('production')).toEqual(['production_manager']);
    expect(deferralChainFor('logistics')).toEqual(['finance']);
    expect(deferralChainFor('sales')).toEqual(['sales_manager']);
  });

  it('未知/空/null 角色 → _default 兜底,长度必 ≥ 1', () => {
    for (const r of [null, undefined, '', '  ', 'nonexistent_role', 'QC' as any]) {
      const c = deferralChainFor(r as any);
      expect(c.length).toBeGreaterThan(0);
    }
    expect(deferralChainFor(null)).toEqual(DEFERRAL_ROUTING._default);
  });

  it('返回的是副本,调用方 push 不会污染路由表', () => {
    const c = deferralChainFor('procurement');
    c.push('hacked');
    expect(DEFERRAL_ROUTING.procurement).toEqual(['order_manager']);
  });
});

describe('空链回落不放宽权限', () => {
  const fallback = deferralChainFor(null);   // ['order_manager']

  it('回落后本步角色仍是 order_manager,不是"谁都能批"', () => {
    expect(fallback[0]).toBe('order_manager');
    expect(canActOnDeferralStep({ roles: ['merchandiser'], requiredRole: fallback[0] })).toBe(false);
    expect(canActOnDeferralStep({ roles: ['procurement'], requiredRole: fallback[0] })).toBe(false);
  });

  it('全局审批人(admin/order_manager/sales_manager)本来就能代任一步 —— 回落没有新增权限', () => {
    for (const r of ['admin', 'order_manager', 'sales_manager']) {
      expect(canActOnDeferralStep({ roles: [r], requiredRole: fallback[0] })).toBe(true);
    }
  });

  it('自批门禁不受回落影响(admin 例外照旧)', () => {
    expect(canActOnDeferralStep({ roles: ['order_manager'], requiredRole: 'order_manager', actorId: 'u1', requesterId: 'u1' })).toBe(false);
    expect(canActOnDeferralStep({ roles: ['admin'], requiredRole: 'order_manager', actorId: 'u1', requesterId: 'u1' })).toBe(true);
  });
});
