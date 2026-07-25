import { describe, it, expect } from 'vitest';
import { SCORING_CONFIG, ontimeDeduction, ontimeScoreFrom } from '@/lib/domain/scoring-constants';

// Q2 评分尺度(2026-07-25 CEO 批):关键节点逾期 -8、非关键 -3、归责豁免不扣。
describe('准时分:关键/非关键加权 + 归责豁免', () => {
  it('尺度常量对齐 CEO 批准值', () => {
    expect(SCORING_CONFIG.ontime.max).toBe(40);
    expect(SCORING_CONFIG.ontime.criticalPenalty).toBe(8);
    expect(SCORING_CONFIG.ontime.nonCriticalPenalty).toBe(3);
    expect([...SCORING_CONFIG.ontime.exemptCategories]).toEqual(['customer', 'supplier', 'force_majeure']);
  });

  it('无逾期 → 满分 40', () => {
    expect(ontimeScoreFrom([])).toBe(40);
  });

  it('1 个关键节点逾期 → -8 = 32', () => {
    expect(ontimeScoreFrom([{ isCritical: true, exempt: false }])).toBe(32);
  });

  it('1 个非关键节点逾期 → -3 = 37(比关键轻)', () => {
    expect(ontimeScoreFrom([{ isCritical: false, exempt: false }])).toBe(37);
  });

  it('关键+非关键混合:2关键+1非关键 = -(8+8+3)=19 → 21', () => {
    const nodes = [
      { isCritical: true, exempt: false }, { isCritical: true, exempt: false }, { isCritical: false, exempt: false },
    ];
    expect(ontimeDeduction(nodes)).toBe(19);
    expect(ontimeScoreFrom(nodes)).toBe(21);
  });

  it('归责豁免:逾期但 exempt=true → 不扣(即使关键)', () => {
    expect(ontimeScoreFrom([{ isCritical: true, exempt: true }])).toBe(40);
    // 一关键扣分 + 一关键豁免 → 只扣 8
    expect(ontimeScoreFrom([{ isCritical: true, exempt: false }, { isCritical: true, exempt: true }])).toBe(32);
  });

  it('扣到 0 封底,不为负', () => {
    const many = Array.from({ length: 10 }, () => ({ isCritical: true, exempt: false }));  // -80
    expect(ontimeScoreFrom(many)).toBe(0);
  });
});
