/**
 * R1-D 生产 Trace —— R1D_SMOKE=1 才跑。
 *
 * 验收:Decision → Command → Mutation → Audit → Outcome 的反查链真实存在。
 * 场景 A 改单 / 场景 B 延期驳回。全部独立 DB 查询,不信函数返回值。
 * 测试数据自建自清。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createClient as mkClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// CI 没有 .env.local:文件缺失时静默跳过(本文件的用例在缺凭证时本来就 skip)。
// 原来无保护 readFileSync → import 阶段就 ENOENT,4 个生产测试在 CI 必红。
const _envPath = resolve(__dirname, '../.env.local');
for (const l of (existsSync(_envPath) ? readFileSync(_envPath, 'utf-8') : '').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const ALEX = '644baf3c-60d8-48d7-860b-bb6afe9a5b76';

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: any) => f }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }), headers: async () => new Map() }));
vi.mock('@/lib/supabase/server', async () => {
  const { createClient: mk } = await import('@supabase/supabase-js');
  const client = () => mk(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const withAuth = () => {
    const c: any = client();
    c.auth.getUser = async () => ({ data: { user: { id: ALEX, email: 'alex@qimoclothing.com' } }, error: null });
    return c;
  };
  return { createClient: async () => withAuth(), createServiceRoleClient: () => client() };
});

// 顶层构造:缺 env 时给占位值,避免 CI 里 import 阶段就 `supabaseUrl is required` 崩掉。
// 本文件的用例全部 describe.skipIf(缺凭证即跳过),顶层 afterAll 的清理列表也是空的,
// 所以占位客户端不会发出任何请求 —— 只是让文件能被加载。
const svc = mkClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key',
);
let orderId = '';
const cleanup: Array<[string, string]> = [];

describe.skipIf(!process.env.R1D_SMOKE)('R1-D 生产 Trace', () => {
  beforeAll(async () => {
    const { data, error } = await (svc.from('orders') as any).insert({
      order_no: `R1D-TRACE-${Date.now()}`, customer_name: '【测试勿动】R1D-TRACE',
      incoterm: 'FOB', order_type: 'bulk', packaging_type: 'standard', lifecycle_status: 'active',
      quantity: 100, quantity_unit: '件', unit_price: 10, total_amount: 1000,
      factory_date: '2026-12-01', order_date: '2026-08-08', owner_user_id: ALEX, created_by: ALEX,
    }).select('id').single();
    if (error) throw new Error(error.message);
    orderId = (data as any).id; cleanup.push(['orders', orderId]);
  }, 60000);

  afterAll(async () => {
    await (svc.from('notifications') as any).delete().eq('related_order_id', orderId);
    await (svc.from('order_logs') as any).delete().eq('order_id', orderId);
    await (svc.from('milestone_logs') as any).delete().eq('order_id', orderId);
    for (const [t, id] of cleanup.reverse()) await (svc.from(t) as any).delete().eq('id', id);
  }, 60000);

  it('场景A 改单:从 orders 最终状态反查 → 审计 → decision → actor → before/after', async () => {
    const { data: am } = await (svc.from('order_amendments') as any).insert({
      order_id: orderId, requested_by: ALEX, status: 'pending', reason: 'R1D trace:客户加量',
      fields_to_change: { quantity_increase: { from: 100, to: 180 } },
    }).select('id').single();
    cleanup.push(['order_amendments', (am as any).id]);
    const { approveOrderAmendment } = await import('@/app/actions/order-amendments');
    const res = await approveOrderAmendment((am as any).id, true, 'R1D trace 批准');
    expect((res as any).success).toBe(true);

    // ═══ 反查(只用 DB)═══
    // outcome:orders 现值
    const order = (await (svc.from('orders') as any).select('quantity').eq('id', orderId).single()).data;
    expect(Number((order as any).quantity)).toBe(180);
    // ← audit:critical_mutation:orders
    const { data: logs } = await (svc.from('order_logs') as any)
      .select('action, actor_user_id, payload').eq('order_id', orderId).eq('action', 'critical_mutation:orders');
    expect((logs || []).length).toBe(1);
    const pl = (logs as any)[0].payload;
    // ← actor(统一信封)
    expect(pl.actor.type).toBe('user');
    expect(pl.actor.id).toBe(ALEX);
    // ← before/after
    expect(String(pl.before.quantity)).toBe('100');
    expect(String(pl.after.quantity)).toBe('180');
    // ← decision:decision_id → order_amendments 行 → 申请人/审批人/理由
    expect(pl.decision_id).toBe((am as any).id);
    const dec = (await (svc.from('order_amendments') as any)
      .select('requested_by, reviewed_by, reason, status').eq('id', pl.decision_id).single()).data;
    expect((dec as any).requested_by).toBe(ALEX);
    expect((dec as any).reviewed_by).toBe(ALEX);
    expect((dec as any).status).toBe('approved');
    expect((dec as any).reason).toContain('客户加量');
    console.log(`[TRACE-A] orders.quantity=180 ← order_logs#critical_mutation(actor=${pl.actor.id.slice(0, 8)}, before=${pl.before.quantity}, after=${pl.after.quantity}) ← decision=${pl.decision_id.slice(0, 8)}(理由:${(dec as any).reason})`);
  }, 120000);

  it('场景B 延期驳回:从 delay_requests 最终状态反查 → 审计事件 → actor/理由', async () => {
    const { data: ms } = await (svc.from('milestones') as any).insert({
      order_id: orderId, name: 'R1D节点', step_key: 'po_confirmed', status: 'in_progress',
      due_at: '2026-11-01', planned_at: '2026-10-25', owner_role: 'sales', sequence_number: 1,
    }).select('id').single();
    cleanup.push(['milestones', (ms as any).id]);
    const { data: dr } = await (svc.from('delay_requests') as any).insert({
      order_id: orderId, milestone_id: (ms as any).id, requested_by: ALEX, status: 'pending',
      reason: 'R1D trace', proposed_new_anchor_date: '2026-12-15',
    }).select('id').single();
    cleanup.push(['delay_requests', (dr as any).id]);

    const { rejectDelayRequest } = await import('@/app/actions/delays');
    await rejectDelayRequest((dr as any).id, 'R1D trace 驳回:理由不充分');

    // outcome
    const after = (await (svc.from('delay_requests') as any).select('status, approved_by, decision_note').eq('id', (dr as any).id).single()).data;
    expect((after as any).status).toBe('rejected');
    expect((after as any).approved_by).toBe(ALEX);
    // ← audit(统一层写的 milestone_logs,信封含 actor)
    const { data: logs } = await (svc.from('milestone_logs') as any)
      .select('action, actor_user_id, payload, note').eq('order_id', orderId).eq('action', 'reject_delay');
    expect((logs || []).length).toBeGreaterThanOrEqual(1);
    const pl = (logs as any)[0].payload;
    expect(pl.actor.id).toBe(ALEX);
    expect(pl.meta?.delay_request_id ?? pl.meta?.delay_request_id ?? (pl.meta || {}).delay_request_id).toBeDefined();
    console.log(`[TRACE-B] delay#${String((dr as any).id).slice(0, 8)} rejected ← milestone_logs#reject_delay(actor=${pl.actor.id.slice(0, 8)}) ← decision_note=${(after as any).decision_note}`);
  }, 120000);
});
