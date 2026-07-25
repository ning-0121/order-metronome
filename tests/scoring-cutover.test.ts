import { describe, it, expect } from 'vitest';
import { isOrderAssessed } from '@/lib/domain/scoring-constants';

// 考评生效日切换(CEO 批 2026-07-25):只考评生效日当天及以后【按建单日】新建的订单。
describe('isOrderAssessed 考评生效日切换', () => {
  const EFF = '2026-07-28';   // 假设生效日

  it('生效日当天及以后建的 → 计入', () => {
    expect(isOrderAssessed('2026-07-28T00:00:00+08:00', EFF)).toBe(true);
    expect(isOrderAssessed('2026-07-28T09:00:00+08:00', EFF)).toBe(true);
    expect(isOrderAssessed('2026-08-01T00:00:00+08:00', EFF)).toBe(true);
  });

  it('生效日之前建的(本周新建/在途/历史)→ 不计入', () => {
    expect(isOrderAssessed('2026-07-27T23:59:00+08:00', EFF)).toBe(false);
    expect(isOrderAssessed('2026-07-25T10:00:00+08:00', EFF)).toBe(false);   // 本周新建
    expect(isOrderAssessed('2026-06-01T00:00:00+08:00', EFF)).toBe(false);   // 历史
  });

  it('未设生效日(env 空)→ 全部计入(安全默认,切换未启用)', () => {
    expect(isOrderAssessed('2026-06-01T00:00:00+08:00', '')).toBe(true);
    expect(isOrderAssessed('2020-01-01T00:00:00+08:00', '')).toBe(true);
  });

  it('无建单日 / 非法日期 → 保守计入(不误判为不计入)', () => {
    expect(isOrderAssessed(null, EFF)).toBe(true);
    expect(isOrderAssessed(undefined, EFF)).toBe(true);
    expect(isOrderAssessed('bad', EFF)).toBe(true);
  });
});
