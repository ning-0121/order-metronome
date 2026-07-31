import { describe, it, expect } from 'vitest';
import {
  finalQcRejection,
  parseChecklistData,
  CHECKLIST_MAP,
  FINAL_QC_RESULT_KEYS,
  FINAL_QC_OPINION_KEY,
} from '@/lib/domain/checklist';

/**
 * 出运质量门禁回归（2026-07-30）。
 *
 * 事故：app/actions/milestones.ts 的「尾查不合格不能出运」拦截读的是 `final_qc_result`，
 * 而清单定义写的是 `final_result` —— key 对不上，这条分支从上线起对任何一单都没生效过。
 * 唯一真正拦住不合格出运的是 qc_inspections 兜底，而那张表要 QC 去一个他们被告知不要用的
 * 页签（/orders/[id]?tab=qc）手工建行。
 *
 * 这组用例把「清单定义的结论字段」和「门禁读的结论字段」焊在一起，
 * 以后谁改清单 key 而没改门禁，会在 CI 上红。
 */
describe('出运质量门禁 · 尾查结论', () => {
  it('清单定义的尾查结论 key 必须在门禁认的 key 集合里（防再次漂移）', () => {
    const items = CHECKLIST_MAP.final_qc_check.items;
    const resultItem = items.find(i => i.label === '尾查结果');
    expect(resultItem, 'final_qc_check 里应有「尾查结果」字段').toBeTruthy();
    expect(FINAL_QC_RESULT_KEYS as readonly string[]).toContain(resultItem!.key);
  });

  it('业务尾查节点的判定 key 必须是门禁认的 sales_opinion', () => {
    const items = CHECKLIST_MAP.final_qc_sales_check.items;
    const opinion = items.find(i => i.label === '业务判断');
    expect(opinion?.key).toBe(FINAL_QC_OPINION_KEY);
    // 门禁拦的是「拒绝出货」这个字面量，它必须还在选项里
    expect(opinion?.options).toContain('拒绝出货');
  });

  it('FAIL（不通过）→ 拦', () => {
    const data = JSON.stringify([
      { key: 'final_qc_date', value: '5.12' },
      { key: 'final_result', value: 'FAIL（不通过）' },
    ]);
    expect(finalQcRejection(data)).toMatch(/不合格/);
  });

  it('历史 key final_qc_result 写的 FAIL 同样要拦（生产库现存 2 条老数据）', () => {
    const data = JSON.stringify([{ key: 'final_qc_result', value: 'FAIL（不通过）' }]);
    expect(finalQcRejection(data)).toMatch(/不合格/);
  });

  it('业务尾查「拒绝出货」→ 拦', () => {
    const data = JSON.stringify([
      { key: 'production_final_qc_reviewed', value: true },
      { key: 'sales_opinion', value: '拒绝出货' },
    ]);
    expect(finalQcRejection(data)).toMatch(/拒绝出货/);
  });

  it('PASS / 同意出货 / PENDING → 放行（不误拦）', () => {
    expect(finalQcRejection(JSON.stringify([{ key: 'final_result', value: 'PASS' }]))).toBeNull();
    expect(finalQcRejection(JSON.stringify([{ key: 'sales_opinion', value: '同意出货' }]))).toBeNull();
    // PENDING（待整改复验）不含 FAIL/不通过/不合格 —— 维持原语义，只有明确不合格才拦
    expect(
      finalQcRejection(JSON.stringify([{ key: 'final_result', value: 'PENDING（待整改复验）' }])),
    ).toBeNull();
  });

  it('检验项目里的「不合格」不触发拦截（只认结论字段，不误伤明细）', () => {
    const data = JSON.stringify([
      { key: 'check_size', value: '不合格' },   // 明细项，不是结论
      { key: 'final_result', value: 'PASS' },
    ]);
    expect(finalQcRejection(data)).toBeNull();
  });

  it('空 / 未填结论 → 不拦（能不能完成节点由 validateChecklistComplete 管）', () => {
    expect(finalQcRejection(null)).toBeNull();
    expect(finalQcRejection('[]')).toBeNull();
    expect(finalQcRejection(JSON.stringify([{ key: 'total_qty', value: 10 }]))).toBeNull();
  });

  it('checklist_data 是 JSON 字符串时必须能解析（生产库实际存的就是字符串）', () => {
    // 直接 Array.isArray 会恒 false —— 这正是历史上多处分支静默死掉的原因
    const raw = JSON.stringify([{ key: 'final_result', value: 'FAIL（不通过）' }]);
    expect(Array.isArray(raw)).toBe(false);
    expect(parseChecklistData(raw)).toHaveLength(1);
    expect(finalQcRejection(raw)).toBeTruthy();
  });

  it('坏 JSON / 非数组 → 安全降级为空，不抛', () => {
    expect(() => finalQcRejection('{ 不是数组 }')).not.toThrow();
    expect(finalQcRejection('{ 不是数组 }')).toBeNull();
    expect(finalQcRejection(JSON.stringify({ key: 'final_result' }))).toBeNull();
  });
});
