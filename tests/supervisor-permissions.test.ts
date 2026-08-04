/**
 * 行政督办(admin_assistant)权限边界(2026-08-04 CEO 定调)。
 *
 * CEO 原话:
 *   「价格、数量、明细、日期永远由责任部门自己改。她替填了,责任就转到她身上,
 *     而且填错了没人知道。督办的价值在信息准确,不在代劳。」
 *   「这些督办都改不了才对,请完善,对于价格,她看不到才对。」
 *
 * 关键在于:**光在工作指南里写「不要改」没用,系统上就得改不了。**
 * 文档管不住手,权限组才管得住。这个岗位又天生要看全部订单,
 * 很容易在加新功能时被顺手塞进某个编辑组 —— 所以用测试钉死。
 *
 * 她该有的:全订单**只读**可见性、督办总览、改派责任人。
 * 她不该有的:改生产任务单/装箱单(含数量)、改料单明细、改客户主数据、看金额。
 */
import { describe, it, expect } from 'vitest';
import { ROLE_GROUPS, hasRoleInGroup } from '@/lib/domain/roles';

const SUPERVISOR = ['admin_assistant'];

describe('督办改不了业务数据', () => {
  const FORBIDDEN_EDIT_GROUPS = [
    ['CAN_EDIT_MO', '生产任务单/装箱单(含数量)'],
    ['CAN_EDIT_BOM', '物料清单/采购项(明细)'],
    ['CAN_EDIT_CUSTOMER', '客户主数据'],
    ['CAN_EDIT_PROCUREMENT_EXEC', '采购执行(含单价)'],
  ] as const;

  it.each(FORBIDDEN_EDIT_GROUPS)('%s(%s)不含 admin_assistant', (group) => {
    expect(
      (ROLE_GROUPS as any)[group],
      `${group} 里出现了 admin_assistant —— 督办只核实推动,不替责任部门改数据`,
    ).not.toContain('admin_assistant');
    expect(hasRoleInGroup(SUPERVISOR, group as any)).toBe(false);
  });
});

describe('督办看不到金额', () => {
  it('不在 CAN_SEE_FINANCIALS', () => {
    expect(ROLE_GROUPS.CAN_SEE_FINANCIALS).not.toContain('admin_assistant');
    expect(hasRoleInGroup(SUPERVISOR, 'CAN_SEE_FINANCIALS')).toBe(false);
  });

  it('不在价格审批组', () => {
    expect(ROLE_GROUPS.CAN_APPROVE_PRICE).not.toContain('admin_assistant');
  });
});

describe('督办该有的没被误删', () => {
  it('能看全部订单(只读)—— 这是这个岗位的前提', () => {
    expect(hasRoleInGroup(SUPERVISOR, 'CAN_SEE_ALL_ORDERS')).toBe(true);
    expect(hasRoleInGroup(SUPERVISOR, 'CAN_VIEW_ALL_ORDERS')).toBe(true);
  });

  it('能改派订单责任人(MANAGEMENT)—— 督办要能把活派对人', () => {
    expect(hasRoleInGroup(SUPERVISOR, 'MANAGEMENT')).toBe(true);
  });
});

describe('「能看全部订单」不等于「能看钱」', () => {
  // CAN_SEE_ALL_ORDERS 这个组历史上被当「管理/督导」在用,同时开着一堆东西;
  // 金额必须由 CAN_SEE_FINANCIALS 单独把关,两者不能混。
  it('CAN_SEE_ALL_ORDERS 里有人不在 CAN_SEE_FINANCIALS', () => {
    const seeAll = ROLE_GROUPS.CAN_SEE_ALL_ORDERS as readonly string[];
    const seeMoney = ROLE_GROUPS.CAN_SEE_FINANCIALS as readonly string[];
    const seeOrdersNotMoney = seeAll.filter((r) => !seeMoney.includes(r));
    expect(seeOrdersNotMoney).toContain('admin_assistant');
    expect(seeOrdersNotMoney.length).toBeGreaterThan(0);
  });
});
