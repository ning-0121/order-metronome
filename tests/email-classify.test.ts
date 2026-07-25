import { describe, it, expect } from 'vitest';
import { ruleClassify, MAIL_CATEGORIES, CATEGORY_LABEL } from '@/lib/email/classify';

// 邮件规则分类器(Phase 1 归纳层 Tier 0)—— 纯逻辑、零 token。
describe('ruleClassify 噪音优先', () => {
  it('自动回复/缺席 → 噪音', () => {
    expect(ruleClassify('Out of Office Auto-Reply', 'I am on vacation').category).toBe('噪音');
    expect(ruleClassify('自动回复:休假中', '').isNoise).toBe(true);
  });
  it('退信 → 噪音', () => {
    expect(ruleClassify('Undeliverable: Mail', 'mailer-daemon').category).toBe('噪音');
  });
});

describe('ruleClassify 类别(中英双语)', () => {
  it('投诉/索赔(最高优先)', () => {
    expect(ruleClassify('Quality complaint on PO 12345', 'the goods are defective').category).toBe('投诉');
    expect(ruleClassify('关于质量问题的索赔', '有次品要退货').category).toBe('投诉');
  });
  it('交期/船期', () => {
    expect(ruleClassify('Delivery date update', 'can you expedite the shipment date?').category).toBe('交期');
    expect(ruleClassify('交期确认', '这批货什么时候能发?船期定了吗').category).toBe('交期');
  });
  it('样品', () => {
    expect(ruleClassify('PP sample comments', 'please send the pre-production sample').category).toBe('样品');
    expect(ruleClassify('产前样确认', '封样已收到').category).toBe('样品');
  });
  it('PO/订单', () => {
    expect(ruleClassify('New purchase order attached', 'please confirm order').category).toBe('PO');
    expect(ruleClassify('下单确认', '这是新订单').category).toBe('PO');
  });
  it('报价 / 物流', () => {
    expect(ruleClassify('Quotation request', 'please send your best price').category).toBe('报价');
    expect(ruleClassify('Booking & B/L', 'container customs forwarder').category).toBe('物流');
  });
  it('无命中 → 其他', () => {
    expect(ruleClassify('Hello', 'nice to meet you').category).toBe('其他');
  });
  it('投诉优先于交期(同时命中取投诉)', () => {
    // 既提质量问题又提交期 → 判投诉(优先级更高)
    expect(ruleClassify('Complaint: delivery delayed and defective', 'quality issue + delay').category).toBe('投诉');
  });
});

describe('ruleClassify 重点度', () => {
  it('投诉恒重点度 3', () => {
    expect(ruleClassify('complaint', 'defective goods').importanceHint).toBe(3);
  });
  it('交期本身即重点(3)', () => {
    expect(ruleClassify('delivery date', 'delay').importanceHint).toBe(3);
  });
  it('样品默认 2,加急抬到 3', () => {
    expect(ruleClassify('sample', 'please send sample').importanceHint).toBe(2);
    expect(ruleClassify('URGENT sample', 'need sample asap').importanceHint).toBe(3);
  });
  it('其他默认 1', () => {
    expect(ruleClassify('hello', 'chat').importanceHint).toBe(1);
  });
});

describe('元数据完整', () => {
  it('每个类别都有展示名', () => {
    for (const c of MAIL_CATEGORIES) expect(CATEGORY_LABEL[c]).toBeTruthy();
  });
  it('matched 可解释(命中词非空)', () => {
    expect(ruleClassify('complaint', 'defect').matched.length).toBeGreaterThan(0);
  });
});
