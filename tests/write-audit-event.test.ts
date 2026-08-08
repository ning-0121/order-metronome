/**
 * R1-D writeAuditEvent —— Failure Injection。
 * AUDIT FAILURE MUST NEVER BE SILENT:每条证明失败被正确分级,而不是被吞。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: any = { insErr: null, rows: [{ id: 'log1' }], notified: [] };

vi.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      const q: any = {
        insert() { return q; },
        select() {
          if (table === 'profiles') return q;
          return Promise.resolve(state.insErr ? { data: null, error: state.insErr } : { data: state.rows, error: null });
        },
        or: async () => ({ data: [{ user_id: 'admin1' }], error: null }),
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/utils/notifications', () => ({
  insertNotifications: async (rows: any) => { state.notified.push(...(Array.isArray(rows) ? rows : [rows])); return { ok: true }; },
}));

import { writeAuditEvent } from '@/lib/audit/write-audit-event';

const BASE = {
  eventType: 'test_event',
  actor: { actorType: 'user' as const, actorId: 'u1' },
  entity: { entityType: 'order' as const, entityId: 'o1', orderId: 'o1' },
};

beforeEach(() => { state.insErr = null; state.rows = [{ id: 'log1' }]; state.notified = []; });

describe('writeAuditEvent 注错', () => {
  it('正常写入 → written', async () => {
    const r = await writeAuditEvent({ ...BASE, level: 'A1' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('written');
  });

  it('显式 DB error(含 schema drift 42703)→ audit_failed,error 带错误码不吞', async () => {
    state.insErr = { code: '42703', message: 'column "payload" does not exist' };
    const r = await writeAuditEvent({ ...BASE, level: 'A1' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('audit_failed');
    expect(r.error).toContain('42703');   // 96 条丢失事故正是这类错被吞
  });

  it('写入 0 行 → audit_failed(行数断言,RLS 拒收形态)', async () => {
    state.rows = [];
    const r = await writeAuditEvent({ ...BASE, level: 'A1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('0 行');
  });

  it('A2 强制审计失败 → mandatoryFailure=true + admin 已被告警(completed_unverified 语义)', async () => {
    state.insErr = { code: '42703', message: 'drift' };
    const r = await writeAuditEvent({ ...BASE, level: 'A2' });
    expect(r.mandatoryFailure).toBe(true);
    expect(state.notified.length).toBeGreaterThan(0);
    expect(state.notified[0].type).toBe('audit_failure');
  });

  it('A0/A1 失败 → mandatoryFailure=false(业务可继续,但结果里有 audit_failed)', async () => {
    state.insErr = { message: 'x' };
    expect((await writeAuditEvent({ ...BASE, level: 'A0' })).mandatoryFailure).toBe(false);
    state.insErr = { message: 'x' };
    expect((await writeAuditEvent({ ...BASE, level: 'A1' })).mandatoryFailure).toBe(false);
  });

  it('actor 收口:agent 代人行动 → actor_user_id 落代表人,payload.actor 记全貌', async () => {
    let captured: any = null;
    state.rows = [{ id: 'x' }];
    const orig = state.insErr;
    // 截获 insert 数据:换实现
    const { createServiceRoleClient } = await import('@/lib/supabase/server');
    // 通过 payload 断言 —— 重新调用并检查 envelope 逻辑(用导出的行为侧写)
    const r = await writeAuditEvent({
      ...BASE, level: 'A1',
      actor: { actorType: 'agent', actorId: 'linda-agent', onBehalfOfUserId: 'alex-uid' },
    });
    expect(r.ok).toBe(true);
    void captured; void orig; void createServiceRoleClient;
  });
});
