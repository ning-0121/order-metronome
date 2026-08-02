/**
 * 节点默认负责人回归锁(2026-08-01)。
 *
 * 背景:生产中心攒了 65 个在途无主节点(开裁 33 + 工厂完成 32),根因不是"派错人",
 * 而是 DEFAULT_ASSIGNEES **根本没有 production 条目** —— createOrder 的分配循环找不到
 * matcher 就退到兜底「该角色全公司只有一人才自动派」,而 production 有两个人
 * (潘盛、骆淑娟),兜底不成立 → 节点一出生就无主,而且不报错、没人发现。
 *
 * 这个失败模式很安静:少一个 key,只表现为"某类节点慢慢堆积无人认领"。
 * 所以这里锁两件事:① 该有的 key 一个都不能少;② 关键角色派到对的人。
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_ASSIGNEES, findAssigneeUserId, STRICTLY_PM_STEPS } from '@/lib/domain/default-assignees';

// createOrder 里那个循环实际会查的角色(app/actions/orders.ts)
const ROLES_RESOLVED_AT_CREATE = ['procurement', 'finance', 'logistics', 'production_manager', 'qc', 'production'];

const PROFILES = [
  { user_id: 'u-fy', name: '方园', email: 'fy@qimoclothing.com' },
  { user_id: 'u-pin', name: '王一品', email: 'pin@qimoclothing.com' },
  { user_id: 'u-qzf', name: '秦增富', email: 'qzf@qimoclothing.com' },   // 生产主管(福/富两种写法)
  { user_id: 'u-qzc', name: '秦增超', email: 'qzc@qimoclothing.com' },   // 物流主管
  { user_id: 'u-lsj', name: '骆淑娟', email: 'lsj@qimoclothing.com' },   // 生产跟单 / QC
  { user_id: 'u-ps', name: '潘盛', email: 'ps@qimoclothing.com' },       // 第二个 production 持有者
];

describe('建单时会查的角色,每个都得有默认负责人', () => {
  it.each(ROLES_RESOLVED_AT_CREATE)('%s 有 matcher', (role) => {
    // 缺一个 key 就会静默退化成"全公司唯一才派",人一多就永远无主
    expect(DEFAULT_ASSIGNEES[role], `DEFAULT_ASSIGNEES 缺 ${role}`).toBeTruthy();
  });
});

describe('关键角色派到对的人', () => {
  const who = (role: string) => findAssigneeUserId(PROFILES, DEFAULT_ASSIGNEES[role]);

  it('生产跟单(production)= 骆淑娟 —— 不是生产主管秦增富', () => {
    expect(who('production')).toBe('u-lsj');
    expect(who('production')).not.toBe('u-qzf');
  });

  it('QC 与生产跟单是同一人(CEO 2026-08-01)', () => {
    expect(who('qc')).toBe(who('production'));
  });

  it('生产主管(production_manager)= 秦增富,与生产跟单分开', () => {
    expect(who('production_manager')).toBe('u-qzf');
    expect(who('production_manager')).not.toBe(who('production'));
  });

  it('物流 = 秦增超,别和生产主管秦增福混(名字太像)', () => {
    expect(who('logistics')).toBe('u-qzc');
    expect(who('logistics')).not.toBe(who('production_manager'));
  });

  it('财务 = 方园 / 采购 = 王一品', () => {
    expect(who('finance')).toBe('u-fy');
    expect(who('procurement')).toBe('u-pin');
  });

  it('秦增福写成「秦增富」也能匹配上(防匹配失败→无主)', () => {
    expect(findAssigneeUserId(
      [{ user_id: 'u-x', name: '秦增福', email: 'other@qimoclothing.com' }],
      DEFAULT_ASSIGNEES.production_manager,
    )).toBe('u-x');
  });
});

describe('生产主管固定节点不被生产跟单顶掉', () => {
  it('STRICTLY_PM_STEPS 仍是主管专属的三个', () => {
    expect([...STRICTLY_PM_STEPS].sort()).toEqual(
      ['bulk_materials_confirmed', 'factory_confirmed', 'pre_production_sample_ready'],
    );
  });
});
