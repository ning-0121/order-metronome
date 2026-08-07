/**
 * R1-C Execution Integrity —— Failure Injection(原语层)。
 *
 * 重点不是 happy path:每条都证明系统在该失败的地方**返回失败**,
 * 不会把 0 行/错列/回读不一致翻译成 success。
 * 场景对应 CEO 验收清单 1-5(路径层的 6-10 在迁移路径的调用顺序里落实,冒烟复核)。
 */

import { describe, it, expect } from 'vitest';
import { safeMutation, safeCriticalMutation } from '@/lib/db/safe-mutation';

/** 可编程假客户端:按脚本回放 error / 返回行 / 回读行 */
function fakeClient(script: {
  writeError?: { code?: string; message: string };
  writeRows?: any[];
  beforeRow?: any | null;
  afterRow?: any | null;
  afterError?: string;
}) {
  let readCount = 0;
  return {
    from() {
      const q: any = {
        update() { return q; }, delete() { return q; }, insert() { return q; }, upsert() { return q; },
        eq() { return q; }, is() { return q; },
        select() {
          // 写链的 .select() 返回 promise;读链继续到 maybeSingle
          const p: any = Promise.resolve(
            script.writeError ? { data: null, error: script.writeError } : { data: script.writeRows ?? [], error: null },
          );
          p.eq = () => p; p.maybeSingle = async () => {
            readCount++;
            if (readCount === 1) return { data: script.beforeRow === undefined ? { id: 'x' } : script.beforeRow, error: null };
            if (script.afterError) return { data: null, error: { message: script.afterError } };
            return { data: script.afterRow === undefined ? { id: 'x' } : script.afterRow, error: null };
          };
          return p;
        },
      };
      return q;
    },
  } as any;
}

const CTX = { actor: 'u1', reason: 'test', riskLevel: 'money' as const };

describe('safeMutation:写入确认', () => {
  it('场景1 Supabase 显式 error → db_error,绝不 ok', async () => {
    const r = await safeMutation({ client: fakeClient({ writeError: { code: '42703', message: 'column ghost does not exist' } }), table: 'orders', operation: 'update', payload: { x: 1 }, predicate: { id: 'a' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('db_error');
  });

  it('场景2 UPDATE 0 行且 error=null(RLS 过滤形态)→ zero_rows —— 这是本层存在的理由', async () => {
    const r = await safeMutation({ client: fakeClient({ writeRows: [] }), table: 'orders', operation: 'update', payload: { x: 1 }, predicate: { id: 'a' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('zero_rows');
    expect(r.error).toContain('RLS');
  });

  it('场景3 受影响行数超预期 → row_count_mismatch(谓词写宽了必须被抓)', async () => {
    const r = await safeMutation({ client: fakeClient({ writeRows: [{ id: 'a' }, { id: 'b' }] }), table: 'orders', operation: 'update', payload: { x: 1 }, predicate: { status: 'pending' }, expectedRows: 1 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('row_count_mismatch');
    expect(r.affectedRows).toBe(2);
  });

  it('约束冲突(23505)→ conflict 而非笼统 db_error', async () => {
    const r = await safeMutation({ client: fakeClient({ writeError: { code: '23505', message: 'duplicate' } }), table: 'orders', operation: 'insert', payload: { x: 1 } });
    expect(r.status).toBe('conflict');
  });

  it("RLS 显式拒绝 → forbidden", async () => {
    const r = await safeMutation({ client: fakeClient({ writeError: { message: 'new row violates row-level security policy' } }), table: 'orders', operation: 'update', payload: { x: 1 }, predicate: { id: 'a' } });
    expect(r.status).toBe('forbidden');
  });

  it("expectedRows='any':清理类 0 行合法", async () => {
    const r = await safeMutation({ client: fakeClient({ writeRows: [] }), table: 'daily_tasks', operation: 'update', payload: { x: 1 }, predicate: { id: 'a' }, expectedRows: 'any' });
    expect(r.ok).toBe(true);
    expect(r.affectedRows).toBe(0);
  });
});

describe('safeCriticalMutation:verified outcome', () => {
  it('场景4 写后回读与期望不符 → verification_failed,ok=false(写入返回说成功也不算数)', async () => {
    const r = await safeCriticalMutation({
      client: fakeClient({ writeRows: [{ id: 'a' }], beforeRow: { id: 'a', quantity: 100 }, afterRow: { id: 'a', quantity: 100 } }),
      table: 'orders', operation: 'update', payload: { quantity: 200 }, predicate: { id: 'a' },
      ctx: { ...CTX, verifyFields: { quantity: 200 } },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('verification_failed');
    expect(r.error).toContain('quantity');
  });

  it('目标行不存在(before 读不到)→ zero_rows,盲写被禁止', async () => {
    const r = await safeCriticalMutation({
      client: fakeClient({ beforeRow: null }),
      table: 'orders', operation: 'update', payload: { quantity: 200 }, predicate: { id: 'ghost' }, ctx: CTX,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('zero_rows');
  });

  it('回读本身失败 → verification_failed(不确认 = 不成功)', async () => {
    const r = await safeCriticalMutation({
      client: fakeClient({ writeRows: [{ id: 'a' }], beforeRow: { id: 'a', quantity: 100 }, afterError: 'network' }),
      table: 'orders', operation: 'update', payload: { quantity: 200 }, predicate: { id: 'a' }, ctx: CTX,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('verification_failed');
  });

  it('全链通过 → success + before/after 快照(数字/字符串形态差异不误报)', async () => {
    const r = await safeCriticalMutation({
      client: fakeClient({ writeRows: [{ id: 'a' }], beforeRow: { id: 'a', quantity: 100 }, afterRow: { id: 'a', quantity: '200' } }),
      table: 'orders', operation: 'update', payload: { quantity: 200 }, predicate: { id: 'a' },
      ctx: { ...CTX, verifyFields: { quantity: 200 } },
    });
    expect(r.ok).toBe(true);
    expect(r.before).toEqual({ id: 'a', quantity: 100 });
    expect((r.after as any).quantity).toBe('200');
  });
});
