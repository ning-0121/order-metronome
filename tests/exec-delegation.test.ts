/**
 * Executive OS V1 TS1 —— 失败用例 + AI 抽取 schema(不 silent success)。
 * 命令层的生产真链由 tests/exec-e2e.production.test.ts(R1TS1_SMOKE=1)覆盖。
 */
import { describe, it, expect } from 'vitest';
import { validateDelegationExtraction } from '@/lib/ai/scenes/delegation-extract';

describe('delegation-extract 宽容校验 + tentative', () => {
  it('正常抽取:proposed_delegation + constraint', () => {
    const r = validateDelegationExtraction({ items: [
      { item_type: 'proposed_delegation', owner_hint: '欧璐', action: '准备报价', deadline_text: '明天下午前', person: 'Gregory', confidence: 0.9 },
      { item_type: 'constraint', constraint_type: 'min_margin', constraint_value: 15, restrict: 'send', confidence: 0.95 },
    ] });
    expect(r.items).toHaveLength(2);
    expect(r.items[0].owner_hint).toBe('欧璐');
    expect(r.items[1].constraint_value).toBe(15);
  });
  it('"可能来中国" → tentative=true(不写成已确认)', () => {
    const r = validateDelegationExtraction({ items: [{ item_type: 'fact', text: 'Gregory 可能来中国', tentative: true, confidence: 0.6 }] });
    expect(r.items[0].tentative).toBe(true);
  });
  it('非法 item_type 降级 fact,不整体失败', () => {
    const r = validateDelegationExtraction({ items: [{ item_type: 'garbage', confidence: 0.5 }] });
    expect(r.items[0].item_type).toBe('fact');
  });
  it('confidence 越界钳到 [0,1]', () => {
    const r = validateDelegationExtraction({ items: [{ item_type: 'fact', confidence: 5 }] });
    expect(r.items[0].confidence).toBe(1);
  });
  it('空/缺 items → 空数组(不崩)', () => {
    expect(validateDelegationExtraction({}).items).toEqual([]);
    expect(validateDelegationExtraction({ items: null }).items).toEqual([]);
  });
});
