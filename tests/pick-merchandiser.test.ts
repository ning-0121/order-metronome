/**
 * 「跟单是谁」必须是确定性的 —— 锁住这一点。
 *
 * 2026-08-05:原写法 `milestones.find(m => m.owner_role==='merchandiser' && m.owner_user_id)`
 * 取第一条,而节点查询没有 ORDER BY、返回顺序未定义。实测 202 张有 merchandiser 节点的单里
 * 82 张(40%)的节点分属 2~3 个不同的人 —— 也就是说列表上显示谁纯看数据库当次返回顺序。
 * 把节点查询分块从 200 改成 40 之后,「有跟单名」的单数就从 194 变成 195,才暴露出来。
 *
 * 这里的核心用例是「同一批节点打乱顺序,结果必须不变」。没有它,
 * 下次谁再动分块大小/加个 order by,这个字段又会静默漂移。
 */

import { describe, it, expect } from 'vitest';
import { pickMerchandiser } from '@/lib/domain/merchandiser';

const ms = (pairs: Array<[string | null, string?]>) =>
  pairs.map(([uid, role]) => ({ owner_user_id: uid, owner_role: role ?? 'merchandiser', name: 'x' }));

describe('pickMerchandiser', () => {
  it('多数票胜出', () => {
    expect(pickMerchandiser(ms([['a'], ['b'], ['a'], ['a'], ['b']]))).toBe('a');
  });

  it('打乱顺序结果不变 —— 这是这个函数存在的理由', () => {
    const rows = ms([['a'], ['b'], ['a'], ['c'], ['b'], ['a']]);
    const shuffles = [
      rows, [...rows].reverse(),
      [rows[3], rows[1], rows[5], rows[0], rows[4], rows[2]],
      [rows[2], rows[4], rows[0], rows[3], rows[1], rows[5]],
    ];
    const got = shuffles.map((s) => pickMerchandiser(s));
    expect(new Set(got).size).toBe(1);
    expect(got[0]).toBe('a');
  });

  it('同票按 user_id 字典序,不看谁排前面', () => {
    expect(pickMerchandiser(ms([['zz'], ['aa']]))).toBe('aa');
    expect(pickMerchandiser(ms([['aa'], ['zz']]))).toBe('aa');
  });

  it('只认 merchandiser 角色,别的角色不算票', () => {
    expect(pickMerchandiser(ms([['a', 'production'], ['a', 'qc'], ['b']]))).toBe('b');
  });

  it('没有 owner_user_id 的节点不算票', () => {
    expect(pickMerchandiser(ms([[null], [null], ['b']]))).toBe('b');
  });

  it('没有 merchandiser 节点 → null(终结单默认不拉节点,会走到这里)', () => {
    expect(pickMerchandiser([])).toBeNull();
    expect(pickMerchandiser(undefined)).toBeNull();
    expect(pickMerchandiser(ms([['a', 'logistics']]))).toBeNull();
  });
});
