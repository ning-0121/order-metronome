import { describe, it, expect } from 'vitest';
import { hasRoleInGroup, ROLE_GROUPS } from '@/lib/domain/roles';

/**
 * QC 订单可见性红线(2026-07-30 用户:QC 从生产部跟单中分离为独立角色)。
 *
 * QC 要对**所有订单**做上线审查/中查/尾查/加查 → 必须跨负责人看见每一张单。
 * 但 CAN_SEE_ALL_ORDERS 这个组早被当「管理/督导」在用,同时开着:全部待审批(含价格/财务)、
 * 所有客户邮件归纳、督办总览入口、物流权限。QC 只该拿到订单可见性,不该拿到这些。
 *
 * 所以拆了 CAN_VIEW_ALL_ORDERS(= 管理层 + QC,只管订单可见性)。
 * 本测试锁死这条边界:以后谁想图省事把 qc 塞回 CAN_SEE_ALL_ORDERS,这里会红。
 */

describe('QC 订单可见性边界', () => {
  for (const role of ['qc', 'quality'] as const) {
    it(`${role}:看得见所有订单`, () => {
      expect(hasRoleInGroup([role], 'CAN_VIEW_ALL_ORDERS')).toBe(true);
    });

    it(`${role}:拿不到督办/审批/邮件(不在 CAN_SEE_ALL_ORDERS)`, () => {
      expect(hasRoleInGroup([role], 'CAN_SEE_ALL_ORDERS')).toBe(false);
    });

    it(`${role}:看不到任何价格`, () => {
      expect(hasRoleInGroup([role], 'CAN_SEE_FINANCIALS')).toBe(false);
      expect(hasRoleInGroup([role], 'CAN_SEE_PROCUREMENT_FLOOR')).toBe(false);
    });

    it(`${role}:不能审批延期、不能改派负责人`, () => {
      expect(hasRoleInGroup([role], 'CAN_APPROVE_DELAY')).toBe(false);
      expect(hasRoleInGroup([role], 'CAN_REASSIGN_OWNER')).toBe(false);
    });
  }

  // 生产部跟单(production)= 只看分配给自己的单,不因本次改动被放开
  it('production(生产部跟单)仍只看自己的单', () => {
    expect(hasRoleInGroup(['production'], 'CAN_VIEW_ALL_ORDERS')).toBe(false);
    expect(hasRoleInGroup(['production'], 'CAN_SEE_ALL_ORDERS')).toBe(false);
  });

  it('merchandiser 仍只看自己的单', () => {
    expect(hasRoleInGroup(['merchandiser'], 'CAN_VIEW_ALL_ORDERS')).toBe(false);
  });

  // 本次只多放 QC,别的角色两组必须完全一致 —— 防止有人往 VIEW 组里夹带别的角色
  it('除 QC 外,两组成员完全一致(没夹带别人)', () => {
    const view = new Set<string>(ROLE_GROUPS.CAN_VIEW_ALL_ORDERS as readonly string[]);
    const seeAll = new Set<string>(ROLE_GROUPS.CAN_SEE_ALL_ORDERS as readonly string[]);
    const extra = [...view].filter((r) => !seeAll.has(r)).sort();
    expect(extra).toEqual(['qc', 'quality']);
    // CAN_SEE_ALL_ORDERS 的成员必须全都在 VIEW 组里(管理层不能反而看不到订单)
    expect([...seeAll].filter((r) => !view.has(r))).toEqual([]);
  });
});
