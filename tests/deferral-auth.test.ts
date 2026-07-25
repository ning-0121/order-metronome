import { describe, it, expect } from 'vitest';
import { canActOnDeferralStep, deferralChainFor, GLOBAL_DELAY_APPROVERS } from '@/lib/domain/deferral-routing';

describe('canActOnDeferralStep 延期审批授权', () => {
  it('业务执行经理/业务经理 可代任一步(修 UI 闸挡死经理的老问题)', () => {
    expect(canActOnDeferralStep({ roles: ['order_manager'], requiredRole: 'sales' })).toBe(true);
    expect(canActOnDeferralStep({ roles: ['sales_manager'], requiredRole: 'production_manager' })).toBe(true);
    expect(canActOnDeferralStep({ roles: ['admin'], requiredRole: 'anything' })).toBe(true);
  });
  it('精确 requiredRole 角色仍可审本步', () => {
    expect(canActOnDeferralStep({ roles: ['sales'], requiredRole: 'sales' })).toBe(true);
    expect(canActOnDeferralStep({ roles: ['production_manager'], requiredRole: 'production_manager' })).toBe(true);
  });
  it('无关角色不能审', () => {
    expect(canActOnDeferralStep({ roles: ['procurement'], requiredRole: 'sales' })).toBe(false);
    expect(canActOnDeferralStep({ roles: ['merchandiser'], requiredRole: 'production_manager' })).toBe(false);
  });
  it('不能审自己的延期(admin 例外)', () => {
    expect(canActOnDeferralStep({ roles: ['order_manager'], requiredRole: 'sales', actorId: 'u1', requesterId: 'u1' })).toBe(false);
    expect(canActOnDeferralStep({ roles: ['admin'], requiredRole: 'sales', actorId: 'u1', requesterId: 'u1' })).toBe(true);
    expect(canActOnDeferralStep({ roles: ['order_manager'], requiredRole: 'sales', actorId: 'u1', requesterId: 'u2' })).toBe(true);
  });
  it('全局审批人集合 = admin/业务执行经理/业务经理', () => {
    expect([...GLOBAL_DELAY_APPROVERS].sort()).toEqual(['admin', 'order_manager', 'sales_manager']);
  });
});

describe('deferralChainFor 延期路由', () => {
  it('出运(logistics)延期纳入财务(CEO:出运须财务把关)', () => {
    expect(deferralChainFor('logistics')).toEqual(['finance', 'order_manager']);
  });
  it('采购/生产/QC 链正确', () => {
    expect(deferralChainFor('procurement')).toEqual(['merchandiser', 'order_manager']);
    expect(deferralChainFor('production')).toEqual(['production_manager']);
    expect(deferralChainFor('qc')).toEqual(['production_manager']);
  });
  it('未配角色走 admin 兜底', () => {
    expect(deferralChainFor('unknown_role')).toEqual(['admin']);
  });
});
