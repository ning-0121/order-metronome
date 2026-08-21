import { describe, it, expect } from 'vitest';
import { parseEmailForOrderInfo } from '@/lib/utils/imap-fetch';

/**
 * PO 号提取 —— 回归锁(2026-08-21)。
 *
 * 原实现 push 的是 m[0](整个匹配串「PO 613」)而不是捕获组 m[1](「613」),
 * 于是拿去查 order_no/po_number 永远查不到。实测 3997 封邮件里 150 封主题
 * 含「PO 数字」,关联成功 0 封 —— 这条路径自上线起从未生效。
 *
 * 这些用例的主题全部取自生产库真实邮件。
 */
describe('parseEmailForOrderInfo — PO 号提取', () => {
  it('提取的是号码本身,不带 PO 前缀', () => {
    expect(parseEmailForOrderInfo('PO 613 FLEECE Confirmation of packaging', '')).toMatchObject({
      poNumbers: expect.arrayContaining(['613']),
    });
  });

  it('认得 PO# / PO #/ P.O. 各种写法', () => {
    const forms = [
      ['WS#300560 PO#78828 STYLE#31372', '78828'],
      ['Recall: PO #78808 for WS #800791', '78808'],
      ['P.O. 78736 fabric sample', '78736'],
      ['Purchase Order: 78908 hang tag', '78908'],
    ] as const;
    for (const [subject, expected] of forms) {
      expect(parseEmailForOrderInfo(subject, '').poNumbers).toContain(expected);
    }
  });

  it('QM 单号没有捕获组,回退取整串', () => {
    expect(parseEmailForOrderInfo('Re: QM-20260409-005 交期确认', '').poNumbers)
      .toContain('QM-20260409-005');
  });

  it('已知限制:「PO#A/B」只认带前缀的第一个号', () => {
    // 真实主题。78828 前面是斜杠不是 PO,正则不认 —— 这是当前行为,不是笔误。
    // 影响可接受:mail_inbox.order_id 是单值,一封邮件本来也只能关联一个订单,
    // 首个 PO 能挂上就够了。要支持 A/B 形式得连带处理误伤(斜杠后的数字未必是 PO)。
    expect(parseEmailForOrderInfo('Re: PO#78736/78828 WS#300345/300560', '').poNumbers)
      .toEqual(['78736']);
  });

  it('提取结果可直接用于 order_no/po_number 精确匹配(纯号码,无空格无前缀)', () => {
    for (const po of parseEmailForOrderInfo('RE: WS#300563 PO78827 31411M-BULK', '').poNumbers) {
      expect(po).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  it('客户自己的款号/物流号不该被当成 PO', () => {
    // 这些主题在生产库里出现过,不含 PO 关键词,不能误抓成订单号
    for (const subject of ['WG0903 YOGA WEAR -style HT-13448', '31567BE_Fit comments', 'Samples Sent for art.1634 / 2427']) {
      expect(parseEmailForOrderInfo(subject, '').poNumbers).toEqual([]);
    }
  });
});
