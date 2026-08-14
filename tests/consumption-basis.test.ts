import { describe, it, expect } from 'vitest';
import {
  isBasisConfirmed,
  materialBasisKey,
  suggestBasisFromHistory,
  suggestBasisForBom,
  checkBasisReadiness,
  NEEDS_BOM_CONFIRMATION,
  BASIS_OPTIONS,
} from '@/lib/procurement/consumption-basis';

describe('consumption_basis · 确认判定', () => {
  it('空/null/未知值一律未确认(不能被当成已确认往下跑)', () => {
    for (const v of [null, undefined, '', '  ', 'per_set', 'UNKNOWN', 'PER_SET_X', 0, {}]) {
      expect(isBasisConfirmed(v as any)).toBe(false);
    }
  });

  it('认的四种口径', () => {
    for (const o of BASIS_OPTIONS) expect(isBasisConfirmed(o.value)).toBe(true);
  });
});

describe('consumption_basis · 历史记忆键', () => {
  it('大小写/空格不敏感 —— 同一块料库里写法各不相同也要归到一起', () => {
    expect(materialBasisKey(' 86% POLY  14% SPANDEX 280GSM ', null))
      .toBe(materialBasisKey('86% poly 14% spandex 280gsm', ''));
  });

  it('规格不同 = 不同物料,不能串口径', () => {
    expect(materialBasisKey('主标', '40mm')).not.toBe(materialBasisKey('主标', '50mm'));
  });

  it('物料名为空 → 空键(不参与记忆,避免把所有无名物料归成一类)', () => {
    expect(materialBasisKey('', 'x')).toBe('');
    expect(materialBasisKey(null, null)).toBe('');
  });
});

describe('consumption_basis · 只认历史,绝不按名字猜', () => {
  it('没有历史 → 返回 null,跟单必须确认一次', () => {
    expect(suggestBasisFromHistory([], '主标')).toBeNull();
  });

  it('❗名字像「主标/洗标/面料」也不许猜 —— 这正是数量翻倍事故的来源', () => {
    for (const name of ['主标', '洗标', '主面料', '罗纹', 'fabric', 'care label']) {
      expect(suggestBasisFromHistory([], name)).toBeNull();
    }
  });

  it('历史里那条本身没确认 basis → 不算记忆', () => {
    expect(suggestBasisFromHistory(
      [{ material_name: '主标', consumption_basis: null }], '主标',
    )).toBeNull();
  });

  it('有历史确认 → 带出来并标明来源', () => {
    const s = suggestBasisFromHistory(
      [{ material_name: '主标', consumption_basis: 'PER_SET', updated_at: '2026-07-01' }], '主标',
    );
    expect(s).toEqual({ basis: 'PER_SET', source: 'history', confirmedAt: '2026-07-01' });
  });

  it('历史有两种口径 → 取最近一次确认', () => {
    const s = suggestBasisFromHistory([
      { material_name: 'X', consumption_basis: 'PER_PIECE', updated_at: '2026-05-01' },
      { material_name: 'X', consumption_basis: 'PER_SET', updated_at: '2026-08-01' },
    ], 'X');
    expect(s?.basis).toBe('PER_SET');
  });

  it('不同物料的历史不会串味', () => {
    const hist = [{ material_name: 'A', consumption_basis: 'PER_SET', updated_at: '2026-08-01' }];
    expect(suggestBasisFromHistory(hist, 'B')).toBeNull();
  });

  it('批量出建议:同物料只算一次', () => {
    const m = suggestBasisForBom(
      [{ material_name: 'A' }, { material_name: 'A' }, { material_name: 'B' }],
      [{ material_name: 'A', consumption_basis: 'PER_SET', updated_at: '2026-08-01' }],
    );
    expect(m.size).toBe(1);
    expect(m.get(materialBasisKey('A', null))?.basis).toBe('PER_SET');
  });
});

describe('Procurement Draft 就绪门禁', () => {
  it('全部已确认 → READY', () => {
    const r = checkBasisReadiness([
      { material_name: 'A', consumption_basis: 'PER_SET' },
      { material_name: 'B', consumption_basis: 'PER_PIECE' },
    ]);
    expect(r).toEqual({ ready: true, unconfirmed: [], status: 'READY' });
  });

  it('有一条没确认 → NEEDS_BOM_CONFIRMATION,并列出是哪些物料', () => {
    const r = checkBasisReadiness([
      { material_name: 'A', consumption_basis: 'PER_SET' },
      { material_name: '主标', consumption_basis: null },
      { material_name: '洗标', consumption_basis: '' },
    ]);
    expect(r.ready).toBe(false);
    expect(r.status).toBe(NEEDS_BOM_CONFIRMATION);
    expect(r.unconfirmed).toEqual(['主标', '洗标']);
  });

  it('同一物料多行只报一次(别让跟单看到 30 条重复)', () => {
    const r = checkBasisReadiness(Array.from({ length: 30 }, () => ({ material_name: 'A' })));
    expect(r.unconfirmed).toEqual(['A']);
  });

  it('空 BOM → 就绪(没料就没有未确认的口径;是否允许采购由别的规则管)', () => {
    expect(checkBasisReadiness([]).ready).toBe(true);
  });

  it('未命名物料也要报出来,不能静默跳过', () => {
    expect(checkBasisReadiness([{ material_name: '', consumption_basis: null }]).unconfirmed)
      .toEqual(['(未命名物料)']);
  });
});
