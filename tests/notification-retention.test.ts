/**
 * 通知保留期 —— 锁住「先标已读、后删除」的顺序。
 *
 * 顺序反了不会报错、不会 build 失败,表现是「② 再留 90 天」这句承诺静默作废:
 * 当晚标已读的记录被同一轮的删除规则立刻带走。这类 bug 只能靠测试锁。
 */

import { describe, it, expect } from 'vitest';
import {
  runNotificationRetention, formatRetentionResult, RETENTION,
} from '@/lib/maintenance/notification-retention';

/** 极简 supabase 假客户端:记录调用顺序,并按谓词过滤内存行 */
function fakeSupabase(rows: Array<{ status: string; created_at: string; type?: string }>) {
  const calls: string[] = [];
  let store = [...rows];

  const makeQuery = (mode: 'count' | 'update' | 'delete' | 'select', patch?: any) => {
    const preds: Array<(r: any) => boolean> = [];
    const q: any = {
      eq(col: string, v: any) { preds.push((r) => r[col] === v); return q; },
      lt(col: string, v: any) { preds.push((r) => r[col] < v); return q; },
      range(from: number, to: number) {
        const hit = store.filter((r) => preds.every((p) => p(r)));
        return Promise.resolve({ data: hit.slice(from, to + 1), error: null });
      },
      then(res: any) {
        const hit = store.filter((r) => preds.every((p) => p(r)));
        if (mode === 'count') return res({ count: hit.length, error: null });
        if (mode === 'update') {
          calls.push(`update:${hit.length}`);
          for (const r of hit) Object.assign(r, patch);
          return res({ error: null });
        }
        if (mode === 'delete') {
          calls.push(`delete:${hit.length}`);
          store = store.filter((r) => !hit.includes(r));
          return res({ error: null });
        }
        return res({ data: hit, error: null });
      },
    };
    return q;
  };

  return {
    calls,
    get rows() { return store; },
    from() {
      return {
        select(_c: string, opts?: any) { return makeQuery(opts?.head ? 'count' : 'select'); },
        update(patch: any) { return makeQuery('update', patch); },
        delete() { return makeQuery('delete'); },
      };
    },
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

describe('通知保留期', () => {
  it('90 天前未读 → 标已读,而不是删掉', async () => {
    const s = fakeSupabase([{ status: 'unread', created_at: daysAgo(100) }]);
    const r = await runNotificationRetention(s as any);
    expect(r.markedRead).toBe(1);
    expect(r.deleted).toBe(0);
    expect(s.rows).toHaveLength(1);        // 记录还在
    expect(s.rows[0].status).toBe('read');
  });

  it('刚标已读的不能被同一轮删掉 —— 必须先标已读、后删除', async () => {
    // 100 天前的未读:标已读后 created_at 仍是 100 天前,但没到 180 天,应当活下来
    const s = fakeSupabase([{ status: 'unread', created_at: daysAgo(100) }]);
    await runNotificationRetention(s as any);
    expect(s.calls).toEqual(['update:1']);  // 只 update,没有 delete
    expect(s.rows).toHaveLength(1);
  });

  it('已读满 180 天 → 删除', async () => {
    const s = fakeSupabase([
      { status: 'read', created_at: daysAgo(200) },
      { status: 'read', created_at: daysAgo(170) },  // 没满 180,留
    ]);
    const r = await runNotificationRetention(s as any);
    expect(r.deleted).toBe(1);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].created_at).toBe(daysAgo(170).slice(0, 10) + s.rows[0].created_at.slice(10));
  });

  it('90 天内的一律不动 —— 在办的事不能被清理带走', async () => {
    const s = fakeSupabase([
      { status: 'unread', created_at: daysAgo(1) },
      { status: 'read', created_at: daysAgo(30) },
    ]);
    const r = await runNotificationRetention(s as any);
    expect(r.markedRead).toBe(0);
    expect(r.deleted).toBe(0);
    expect(s.calls).toEqual([]);
    expect(s.rows).toHaveLength(2);
  });

  it('清完仍超阈值 → 报刷屏并给出类型排行(4 月那次就是没人盯)', async () => {
    const many = Array.from({ length: RETENTION.FLOOD_THRESHOLD + 5 }, (_, i) => ({
      status: 'unread', created_at: daysAgo(1), type: i % 3 === 0 ? 'spam_alert' : 'normal',
    }));
    const r = await runNotificationRetention(fakeSupabase(many) as any);
    expect(r.flooding).toBe(true);
    expect(r.topTypes[0].type).toBe('normal');
    expect(formatRetentionResult(r)).toContain('疑似有功能在刷屏');
  });

  it('量正常时不做类型统计 —— 不为哨兵白扫全表', async () => {
    const r = await runNotificationRetention(fakeSupabase([{ status: 'read', created_at: daysAgo(1) }]) as any);
    expect(r.flooding).toBe(false);
    expect(r.topTypes).toEqual([]);
  });
});
