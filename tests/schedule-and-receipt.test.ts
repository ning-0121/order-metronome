import { describe, it, expect } from 'vitest';
import { receiptAmount } from '@/lib/procurement/receipt-amount';
import { STAGE_OF_STEP, roleLabel, statusLabel, bjDayParts } from '@/lib/exports/schedule-shared';

describe('receiptAmount — 收货补价金额 = 单价×数量 + 附加费', () => {
  it('单价×数量 + 附加费(开版费)', () => {
    expect(receiptAmount({ unit_price: 12.5, extra_fee: 500, received_qty: 100 })).toBe(1750);
  });
  it('缺单价/数量/附加费按 0', () => {
    expect(receiptAmount({ unit_price: null, extra_fee: null, received_qty: 100 })).toBe(0);
    expect(receiptAmount({ unit_price: 3, extra_fee: null, received_qty: null as any })).toBe(0);
    expect(receiptAmount({ unit_price: null, extra_fee: 500, received_qty: 0 })).toBe(500);
  });
  it('2 位小数四舍五入', () => {
    expect(receiptAmount({ unit_price: 0.333, extra_fee: 0, received_qty: 3 })).toBe(1);
  });
});

describe('schedule-shared 口径', () => {
  it('初上线跟单确认(P2-A 新节点)归入 4·生产过程', () => {
    expect(STAGE_OF_STEP['initial_line_check']).toBe('4·生产过程');
    expect(STAGE_OF_STEP['mid_qc_check']).toBe('4·生产过程');
  });
  it('roleLabel:merchandiser=业务执行, production=生产, qc=品控', () => {
    expect(roleLabel('merchandiser')).toContain('业务执行');
    expect(roleLabel('production')).toBe('生产');
    expect(roleLabel('qc')).toBe('品控QC');
    expect(roleLabel(null)).toBe('—');
  });
  it('statusLabel 归一', () => {
    expect(statusLabel('done')).toBe('已完成');
    expect(statusLabel('in_progress')).toBe('进行中');
    expect(statusLabel('blocked')).toBe('受阻');
    expect(statusLabel(null)).toBe('未开始');
  });
  it('bjDayParts:UTC 时间按北京日历切星期(周一 16:00 UTC = 周二北京 00:00)', () => {
    // 2026-07-27 是周一。北京周二 00:00 = UTC 周一 16:00
    const p = bjDayParts('2026-07-27T16:00:00Z');
    expect(p.weekday).toBe('周二');
    expect(p.ymd).toBe('2026-07-28');
  });
});
