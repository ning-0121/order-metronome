/**
 * 「待客户指令出运」的逾期豁免 —— 锁住口径。
 *
 * 2026-08-06 CEO:1022945/1022946 货已备好、因客户原因不能出,系统却一直报逾期。
 * 机制(special_tags 标签)早就有,但老三色灯 computeOrderStatus 从来不认它 ——
 * 列表红牌/风险页/CEO 页/督办日报全在点名"业务逾期",标了也白标。
 *
 * 口径:hold 生效 → 阻塞/超期不判红(客户的暂停,不是团队的延误);
 *       hold 超 14 天没更新 → 黄灯(豁免不能变黑洞,否则挂标签就永远不红会被滥用)。
 */

import { describe, it, expect } from 'vitest';
import { computeOrderStatus } from '@/lib/utils/order-status';
import { isCustomerShipHoldFromOrder, isCustomerHoldStale } from '@/lib/domain/customerShipHold';

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const OVERDUE_MS: any[] = [
  { name: '工厂完成', step_key: 'factory_completion', status: 'in_progress', due_at: daysAgo(10) },
  { name: '验货/放行', step_key: 'inspection_release', status: 'blocked', due_at: daysAgo(8) },
];

describe('待客户指令出运 · 逾期豁免', () => {
  it('没挂 hold:阻塞+超期照常判红(豁免不能误伤正常单)', () => {
    const st = computeOrderStatus(OVERDUE_MS);
    expect(st.color).toBe('RED');
  });

  it('挂了 hold 且未过期:不判红,说明是客户原因', () => {
    const st = computeOrderStatus(OVERDUE_MS, { customerShipHold: true, holdStale: false });
    expect(st.color).toBe('GREEN');
    expect(st.reason).toContain('待客户指令出运');
    expect(st.reason).toContain('非延误');
  });

  it('hold 超 14 天没更新:黄灯提醒业务跟进 —— 豁免不能变黑洞', () => {
    const st = computeOrderStatus(OVERDUE_MS, { customerShipHold: true, holdStale: true });
    expect(st.color).toBe('YELLOW');
    expect(st.reason).toContain('14 天');
  });

  it('hold 判定认 special_tags 标签(1022945/1022946 挂的就是它)', () => {
    expect(isCustomerShipHoldFromOrder({ special_tags: ['待客户指令出运'] })).toBe(true);
    expect(isCustomerShipHoldFromOrder({ special_tags: [] })).toBe(false);
  });

  it('stale 判定:出厂日过 14 天才算(出厂日在未来 = 不催)', () => {
    const fut = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    expect(isCustomerHoldStale({ special_tags: ['待客户指令出运'], factory_date: fut })).toBe(false);
    const old = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    expect(isCustomerHoldStale({ special_tags: ['待客户指令出运'], factory_date: old })).toBe(true);
  });
});
