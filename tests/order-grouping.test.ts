import { describe, it, expect } from 'vitest';
import { classifyOrderGroup } from '@/lib/domain/orderGrouping';

/**
 * 订单分组口径(2026-07-30)。
 *
 * 用户报「采购中心/生产中心的数和订单中心对不上」。查下来两边其实能精确对上,
 * 但暴露出订单中心把 **13 张已取消订单算进了「已完成」**:
 *   改前 已完成 90 = 真完成 77 + 已取消 13
 *   改后 已完成 77 / 已取消 13(独立成组)→ 与生产中心「历史完成 77」精确一致
 * 取消 ≠ 交付,混在一起会让完成率虚高、复盘失真。
 */
describe('订单分组:进行中 / 已完成 / 已取消', () => {
  it('已取消 → cancelled,绝不算完成', () => {
    expect(classifyOrderGroup({ lifecycle_status: 'cancelled' })).toBe('cancelled');
    expect(classifyOrderGroup({ lifecycle_status: '已取消' })).toBe('cancelled');
  });

  // 这条是本次 bug 的核心:取消掉的单即便节点碰巧都完成了,也不能算交付
  it('已取消 + 节点全完成 → 仍是 cancelled(不能被节点状态"洗成"完成)', () => {
    expect(classifyOrderGroup(
      { lifecycle_status: 'cancelled' },
      [{ status: 'done' }, { status: 'done' }],
    )).toBe('cancelled');
  });

  it('lifecycle 已完成 → completed', () => {
    expect(classifyOrderGroup({ lifecycle_status: 'completed' })).toBe('completed');
    expect(classifyOrderGroup({ lifecycle_status: '已完成' })).toBe('completed');
  });

  it('节点全完成但 lifecycle 还没关单 → completed(活儿干完了只是没人点)', () => {
    expect(classifyOrderGroup(
      { lifecycle_status: 'active' },
      [{ status: 'done' }, { status: '已完成' }, { status: 'skipped' }],
    )).toBe('completed');
  });

  it('还有节点没完成 → active', () => {
    expect(classifyOrderGroup(
      { lifecycle_status: 'active' },
      [{ status: 'done' }, { status: 'pending' }],
    )).toBe('active');
  });

  it('没有任何节点 → active(不能因为"零个节点全完成"就算完成)', () => {
    expect(classifyOrderGroup({ lifecycle_status: 'active' }, [])).toBe('active');
    expect(classifyOrderGroup({ lifecycle_status: 'draft' })).toBe('active');
  });

  it('三组互斥且穷尽 —— 同一张单只会落在一组', () => {
    const cases = [
      { lifecycle_status: 'active' }, { lifecycle_status: 'draft' },
      { lifecycle_status: 'completed' }, { lifecycle_status: 'cancelled' },
      { lifecycle_status: '已完成' }, { lifecycle_status: '已取消' },
    ];
    for (const c of cases) {
      const g = classifyOrderGroup(c, [{ status: 'pending' }]);
      expect(['active', 'completed', 'cancelled']).toContain(g);
    }
  });
});
