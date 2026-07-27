import { describe, it, expect } from 'vitest';
import { normRef, buildOrderRefIndex, matchSubjectToOrder } from '@/lib/email/subjectOrderMatch';

describe('邮件主题→订单自动匹配', () => {
  const rows = [
    { id: 'o1', internal_order_no: '524', order_no: 'QM-20260401-001', created_at: '2026-04-01' },
    { id: 'o2', internal_order_no: '545B', order_no: 'QM-20260709-009', created_at: '2026-07-09' },
    { id: 'o3', internal_order_no: '600', order_no: 'QM-20260403-031', style_no: '31508BO', created_at: '2026-04-03' },
    { id: 'o4-old', internal_order_no: '524', order_no: 'QM-old', created_at: '2026-01-01' },  // 同号返单(旧)
  ];
  const idx = buildOrderRefIndex(rows);

  it('归一化去空格/连字符/井号大写', () => {
    expect(normRef(' 31508 bo ')).toBe('31508BO');
    expect(normRef('#524')).toBe('524');
  });

  it('主题含内部单号 → 命中', () => {
    expect(matchSubjectToOrder('Re: 524 JUNIOR', idx)).toBe('o1');
  });

  it('主题含系统单号(QM-) → 命中', () => {
    expect(matchSubjectToOrder('[URGENT] Order QM-20260403-031 财务审核', idx)).toBe('o3');
  });

  it('主题含款号 style_no → 命中对应订单', () => {
    expect(matchSubjectToOrder('Re: 31508BO same waistband issue', idx)).toBe('o3');
  });

  it('同号返单取最近创建的', () => {
    expect(matchSubjectToOrder('Re: 524', idx)).toBe('o1');   // o1(2026-04) 比 o4-old(2026-01) 新
  });

  it('库里没有的客户侧 ref(WS#/报价)→ 不误匹配', () => {
    expect(matchSubjectToOrder('Re: NEW WS #300566 STYLE 99999', idx)).toBeNull();
    expect(matchSubjectToOrder('QUOTATION - MAJA', idx)).toBeNull();
  });
});
