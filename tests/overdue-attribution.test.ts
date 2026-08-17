/**
 * Overdue Attribution V1(2026-08-17 CEO 拍板)。
 *
 * 用生产实测的真实形态做基准 —— 581/580/588/564A/1022927 都在下面。
 * 核心不是"把 237 变小",而是让系统答得出:谁能动、谁在等、哪张单有风险、
 * 以及哪些只该知情不该计入绩效。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAttribution, resolveBlocker, classifyOverdue, attributeOrderOverdue,
  assessDeliveryRisk, buildPersonalView, summarize, extractBlockedReason, isOverdue,
  type MilestoneLike,
} from '@/lib/domain/overdue-attribution';

// 取当天正午而非 UTC 午夜:天数算法以「出厂日当天 23:59:59(**本地时区**)」为界,
// 用 00:00Z 在 UTC-7 的机器上会落回前一天,算出 16 而不是线上看到的 17。
// (算法本身依赖运行时时区 —— 既有行为,本轮不扩,已在 attribution 文档里记为观察项。)
const NOW = new Date('2026-08-17T12:00:00Z').getTime();
const past = (d: string) => `${d}T00:00:00Z`;
const names = new Map([['u-winnie', 'Winnie'], ['u-cathy', '菁菁'], ['u-fin', '财务小张']]);

describe('归属链:owner_user_id → owner_role → UNASSIGNED', () => {
  it('有 owner_user_id → 具体人', () => {
    const a = resolveAttribution({ owner_user_id: 'u-winnie', owner_role: 'merchandiser' }, names);
    expect(a.kind).toBe('user');
    expect(a.label).toBe('Winnie');
    expect(a.isOwnershipDefect).toBe(false);
  });

  it('只有 owner_role → 部门(待分配到人),不是缺陷', () => {
    const a = resolveAttribution({ owner_user_id: null, owner_role: 'finance' }, names);
    expect(a.kind).toBe('role');
    expect(a.label).toContain('财务');
    expect(a.isOwnershipDefect).toBe(false);
  });

  it('两者皆无 → UNASSIGNED,且标记为责任配置异常', () => {
    const a = resolveAttribution({ owner_user_id: null, owner_role: null }, names);
    expect(a.kind).toBe('unassigned');
    expect(a.isOwnershipDefect).toBe(true);
  });

  it('绝不回落到订单业务负责人 —— 归属只认节点自身字段', () => {
    // 入参里根本没有 business owner 的位置:签名上就不可能传进来
    const a = resolveAttribution({ owner_user_id: null, owner_role: null }, names);
    expect(a.label).not.toContain('Winnie');
  });
});

describe('blocker 证据分级:不许猜', () => {
  const order: MilestoneLike[] = [
    { step_key: 'po_confirmed', name: 'PO确认', status: 'in_progress', owner_role: 'finance', owner_user_id: 'u-fin' },
    { step_key: 'pi_confirmed', name: 'PI确认', status: 'pending', owner_role: 'merchandiser' },
  ];

  it('有未完成前置 + 前置有责任人 → PREREQUISITE_OWNER,点名到人', () => {
    const b = resolveBlocker(order[1], order, names);
    expect(b.evidence).toBe('PREREQUISITE_OWNER');
    expect(b.blockedByUserId).toBe('u-fin');
    expect(b.label).toContain('财务小张');
    expect(b.label).toContain('PO确认');
  });

  it('前置只有部门 → PREREQUISITE_ROLE,只点到部门', () => {
    const o = [{ ...order[0], owner_user_id: null }, order[1]];
    const b = resolveBlocker(o[1], o, names);
    expect(b.evidence).toBe('PREREQUISITE_ROLE');
    expect(b.blockedByUserId).toBeNull();
    expect(b.blockedByRole).toBe('finance');
  });

  it('无可解析前置、只有文字原因 → REASON_TEXT_ONLY,blocker 标"待确认"不编人', () => {
    const m: MilestoneLike = { step_key: 'unknown_step', status: 'blocked', notes: '卡住原因：客人未回复确认' };
    const b = resolveBlocker(m, [m], names);
    expect(b.evidence).toBe('REASON_TEXT_ONLY');
    expect(b.reason).toBe('客人未回复确认');
    expect(b.blockedByUserId).toBeNull();
    expect(b.blockedByRole).toBeNull();
    expect(b.label).toContain('待确认');
  });

  it('什么证据都没有 → UNKNOWN,明说未识别', () => {
    const m: MilestoneLike = { step_key: 'unknown_step', status: 'blocked', notes: null };
    const b = resolveBlocker(m, [m], names);
    expect(b.evidence).toBe('UNKNOWN');
    expect(b.label).toContain('未识别');
  });

  it('前置已完成 → 不算前置阻塞', () => {
    const o: MilestoneLike[] = [
      { step_key: 'po_confirmed', name: 'PO确认', status: 'done', owner_role: 'finance' },
      { step_key: 'pi_confirmed', name: 'PI确认', status: 'pending', owner_role: 'merchandiser' },
    ];
    expect(resolveBlocker(o[1], o, names).evidence).toBe('UNKNOWN');
  });
});

describe('三桶:blocked 不消失,但不压在被阻塞的人头上', () => {
  it('status=blocked → BLOCKED 桶,不算 actionable', () => {
    const m: MilestoneLike = { step_key: 'x', status: 'blocked', due_at: past('2026-07-01'), owner_user_id: 'u-winnie', notes: '卡住原因：等客人' };
    const r = classifyOverdue(m, [m], NOW, names);
    expect(r.bucket).toBe('BLOCKED');
    expect(r.blocker).not.toBeNull();
  });

  it('有未完成前置 → 即使 status=pending 也是 BLOCKED(催他没意义)', () => {
    const o: MilestoneLike[] = [
      { step_key: 'po_confirmed', name: 'PO确认', status: 'in_progress', owner_role: 'finance', owner_user_id: 'u-fin' },
      { step_key: 'pi_confirmed', name: 'PI确认', status: 'pending', due_at: past('2026-07-01'), owner_user_id: 'u-winnie', sequence_number: 2 },
    ];
    const r = classifyOverdue(o[1], o, NOW, names);
    expect(r.bucket).toBe('BLOCKED');
    expect(r.blocker?.blockedByUserId).toBe('u-fin');
  });

  it('无阻塞 + 已过期 → ACTIONABLE_OVERDUE,算当前责任人', () => {
    const m: MilestoneLike = { step_key: 'lone_step', status: 'pending', due_at: past('2026-07-01'), owner_user_id: 'u-winnie' };
    const r = classifyOverdue(m, [m], NOW, names);
    expect(r.bucket).toBe('ACTIONABLE_OVERDUE');
    expect(r.attribution.userId).toBe('u-winnie');
    expect(r.overdueDays).toBeGreaterThan(40);
  });

  it('已完成 / 未到期 不进任何桶', () => {
    expect(isOverdue({ status: 'done', due_at: past('2026-01-01') }, NOW)).toBe(false);
    expect(isOverdue({ status: 'pending', due_at: '2026-12-01T00:00:00Z' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'pending', due_at: null }, NOW)).toBe(false);
  });
});

describe('581 真实形态:Winnie 被点名,实际卡在财务+采购', () => {
  // 生产实测:逾期 2 个 —— PO确认[finance] due 2026-05-26、采购下单[procurement] due 2026-07-31
  const o581: MilestoneLike[] = [
    { step_key: 'po_confirmed', name: 'PO确认', status: 'in_progress', due_at: past('2026-05-26'), owner_role: 'finance', sequence_number: 1 },
    { step_key: 'production_order_upload', name: '生产单制作', status: 'done', owner_user_id: 'u-winnie', sequence_number: 2 },
    { step_key: 'procurement_order_placed', name: '采购下单', status: 'pending', due_at: past('2026-07-31'), owner_role: 'procurement', sequence_number: 3 },
  ];

  it('两个逾期都不算 Winnie 的 —— 一个财务一个采购', () => {
    const all = attributeOrderOverdue(o581, NOW, names);
    expect(all).toHaveLength(2);
    const roles = all.map((a) => a.attribution.role).sort();
    expect(roles).toEqual(['finance', 'procurement']);
    expect(all.every((a) => a.attribution.userId !== 'u-winnie')).toBe(true);
  });

  it('Winnie 的个人视图:0 条待处理(她这单没有属于她的未完成节点)', () => {
    const all = attributeOrderOverdue(o581, NOW, names);
    const v = buildPersonalView({
      myUserId: 'u-winnie',
      ownedOrderIds: new Set(['581']),
      byOrder: new Map([['581', all]]),
      myMinSeqByOrder: new Map(),   // 她已无未完成节点
    });
    expect(v.mine).toHaveLength(0);
    // 但她是订单负责人 → 必须能在「知情」区看到,不再是"系统里没有"
    expect(v.awareness.length).toBeGreaterThan(0);
  });
});

describe('个人三层视图:知情 ≠ 待办', () => {
  const list: MilestoneLike[] = [
    { step_key: 'a', name: '我的活', status: 'pending', due_at: past('2026-07-01'), owner_user_id: 'u-winnie', sequence_number: 5 },
    { step_key: 'lone_b', name: '财务的活', status: 'pending', due_at: past('2026-07-01'), owner_role: 'finance', owner_user_id: 'u-fin', sequence_number: 2 },
    { step_key: 'lone_c', name: '别人后面的活', status: 'pending', due_at: past('2026-07-01'), owner_role: 'qc', sequence_number: 9 },
  ];

  it('我的 / 卡我的 / 知情 三层各就各位', () => {
    const all = attributeOrderOverdue(list, NOW, names);
    const v = buildPersonalView({
      myUserId: 'u-winnie',
      ownedOrderIds: new Set(['o1']),
      byOrder: new Map([['o1', all]]),
      myMinSeqByOrder: new Map([['o1', 5]]),
    });
    expect(v.mine.map((x) => x.milestone.name)).toEqual(['我的活']);
    expect(v.blockingMe.map((x) => x.milestone.name)).toEqual(['财务的活']);   // seq 2 ≤ 5
    expect(v.awareness.map((x) => x.milestone.name)).toEqual(['别人后面的活']); // seq 9 > 5
  });

  it('不是我负责的订单 → 别人的节点不进我的任何一层', () => {
    const all = attributeOrderOverdue(list, NOW, names);
    const v = buildPersonalView({
      myUserId: 'u-winnie', ownedOrderIds: new Set(),   // 我不是负责人
      byOrder: new Map([['o1', all]]), myMinSeqByOrder: new Map([['o1', 5]]),
    });
    expect(v.awareness).toHaveLength(0);
    expect(v.mine).toHaveLength(1);   // 我自己的活照旧
  });

  it('我的节点若被前置卡住 → 归「正在卡我的」,不进我的待办(催我没用)', () => {
    const o: MilestoneLike[] = [
      { step_key: 'po_confirmed', name: 'PO确认', status: 'pending', owner_role: 'finance', sequence_number: 1 },
      { step_key: 'pi_confirmed', name: '我的活', status: 'pending', due_at: past('2026-07-01'), owner_user_id: 'u-winnie', sequence_number: 2 },
    ];
    const all = attributeOrderOverdue(o, NOW, names);
    const v = buildPersonalView({
      myUserId: 'u-winnie', ownedOrderIds: new Set(['o1']),
      byOrder: new Map([['o1', all]]), myMinSeqByOrder: new Map([['o1', 2]]),
    });
    expect(v.mine).toHaveLength(0);
    expect(v.blockingMe).toHaveLength(1);
  });
});

describe('DELIVERY_RISK 是订单级,不作为个人逾期', () => {
  it('出厂日已过 → late', () => {
    const r = assessDeliveryRisk({ factoryDate: '2026-07-31', attributed: [], now: NOW });
    expect(r.level).toBe('late');
    expect(r.pastFactoryDays).toBe(17);
  });

  it('出厂日未到但有逾期节点 → at_risk', () => {
    const m: MilestoneLike = { step_key: 'lone', status: 'pending', due_at: past('2026-08-01'), owner_role: 'qc' };
    const r = assessDeliveryRisk({ factoryDate: '2026-12-01', attributed: attributeOrderOverdue([m], NOW), now: NOW });
    expect(r.level).toBe('at_risk');
  });

  it('无逾期 → none', () => {
    expect(assessDeliveryRisk({ factoryDate: '2026-12-01', attributed: [], now: NOW }).level).toBe('none');
  });
});

describe('汇总口径', () => {
  it('actionable 按责任部门、blocked 按 blocker 部门,分别统计', () => {
    const o: MilestoneLike[] = [
      { step_key: 'po_confirmed', name: 'PO确认', status: 'in_progress', due_at: past('2026-06-01'), owner_role: 'finance', owner_user_id: 'u-fin', sequence_number: 1 },
      { step_key: 'pi_confirmed', name: 'PI确认', status: 'pending', due_at: past('2026-07-01'), owner_user_id: 'u-winnie', sequence_number: 2 },
      { step_key: 'lone_x', name: '孤立节点', status: 'pending', due_at: past('2026-07-01'), owner_role: null, owner_user_id: null },
    ];
    const s = summarize(attributeOrderOverdue(o, NOW, names));
    expect(s.totalOverdue).toBe(3);
    expect(s.actionable).toBe(2);          // PO确认(无前置) + 孤立节点
    expect(s.blocked).toBe(1);             // PI确认被 PO确认 卡住
    expect(s.unassigned).toBe(1);          // 孤立节点无归属 = 配置缺陷
    expect(s.actionableByRole['finance']).toBe(1);
    expect(s.blockedByBlockerRole['finance']).toBe(1);
    expect(s.blockedByEvidence.PREREQUISITE_OWNER).toBe(1);
  });
});

describe('卡住原因解析', () => {
  it('从 notes 取「卡住原因：」后的正文', () => {
    expect(extractBlockedReason('卡住原因：客人未付尾款')).toBe('客人未付尾款');
    expect(extractBlockedReason('前面有别的备注\n卡住原因：等QC报告\n后面还有')).toBe('等QC报告');
    expect(extractBlockedReason('只是普通备注')).toBeNull();
    expect(extractBlockedReason(null)).toBeNull();
  });
});

describe('天数口径与既有实现锁死(防两处显示不同天数)', () => {
  it('pastFactoryDaysOf 与 triageStaleOrder 逐日一致', async () => {
    const { pastFactoryDaysOf } = await import('@/lib/domain/overdue-attribution');
    const { triageStaleOrder } = await import('@/lib/services/stale-order-triage');
    for (const fd of ['2026-07-31', '2026-08-01', '2026-08-15', '2026-08-16', '2026-06-06', '2026-08-17']) {
      const mine = pastFactoryDaysOf(fd, NOW);
      const theirs = triageStaleOrder({ factoryDate: fd, actualAts: [], overdueCount: 0, now: NOW }).pastFactoryDays;
      expect(mine).toBe(theirs);
    }
  });
});
