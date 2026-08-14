import { describe, it, expect } from 'vitest';
import { pilotOrderNos, isPilotOrder, isPilotEnabled } from '@/lib/procurement/pilot';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('Procurement Generator · Pilot 门禁', () => {
  it('默认关闭 —— env 没配时任何订单都不在 Pilot', () => {
    expect(pilotOrderNos(env({}))).toEqual([]);
    expect(isPilotEnabled(env({}))).toBe(false);
    expect(isPilotOrder({ order_no: 'QM-20260813-001' }, env({}))).toBe(false);
  });

  it('off/false/0 都算关闭(别让手滑写个 false 反而开了)', () => {
    for (const v of ['off', 'OFF', 'false', '0', 'no', '  ']) {
      expect(pilotOrderNos(env({ PROCUREMENT_GENERATOR_PILOT: v }))).toEqual([]);
    }
  });

  it('白名单命中才进 Pilot,其余订单行为不变', () => {
    const e = env({ PROCUREMENT_GENERATOR_PILOT: 'QM-1,QM-2' });
    expect(isPilotOrder({ order_no: 'QM-1' }, e)).toBe(true);
    expect(isPilotOrder({ order_no: 'QM-3' }, e)).toBe(false);
  });

  it('大小写/空格不敏感,分隔符容错', () => {
    const e = env({ PROCUREMENT_GENERATOR_PILOT: ' qm-1 ; QM-2\nqm-3 ' });
    expect(isPilotOrder({ order_no: 'QM-1' }, e)).toBe(true);
    expect(isPilotOrder({ order_no: 'Qm-3' }, e)).toBe(true);
  });

  it('internal_order_no 也认(员工习惯报订单册编号)', () => {
    const e = env({ PROCUREMENT_GENERATOR_PILOT: 'EHL-0801' });
    expect(isPilotOrder({ order_no: 'QM-9', internal_order_no: 'EHL-0801' }, e)).toBe(true);
  });

  it('超上限只取前 N 张,不是全放行(防手滑贴进整列表)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `QM-${i}`).join(',');
    const e = env({ PROCUREMENT_GENERATOR_PILOT: many });
    expect(pilotOrderNos(e)).toHaveLength(5);
    expect(isPilotOrder({ order_no: 'QM-0' }, e)).toBe(true);
    expect(isPilotOrder({ order_no: 'QM-39' }, e)).toBe(false);
  });

  it('上限可调,但仍然是上限', () => {
    const e = env({ PROCUREMENT_GENERATOR_PILOT: 'a,b,c,d,e,f,g', PROCUREMENT_GENERATOR_MAX: '3' });
    expect(pilotOrderNos(e)).toEqual(['a', 'b', 'c']);
  });

  it('空订单对象不崩、不误放行', () => {
    const e = env({ PROCUREMENT_GENERATOR_PILOT: 'QM-1' });
    expect(isPilotOrder(null, e)).toBe(false);
    expect(isPilotOrder({}, e)).toBe(false);
    expect(isPilotOrder({ order_no: '' }, e)).toBe(false);
  });

  it('去重:同一单写两遍不占两个名额', () => {
    const e = env({ PROCUREMENT_GENERATOR_PILOT: 'a,a,b' });
    expect(pilotOrderNos(e)).toEqual(['a', 'b']);
  });
});
