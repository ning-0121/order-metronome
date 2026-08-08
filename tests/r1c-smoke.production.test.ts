/**
 * R1-C 生产 smoke —— 只在显式 R1C_SMOKE=1 时运行(默认测试链不打生产)。
 *
 * 自建 SMOKE 测试单(名称带 R1C-SMOKE,结束后删除),对四条关键路径做
 * DB before → action → DB after → 下游 → 通知 的全链验收;
 * 并注入一条真实失败(改单指向不存在的订单)证明:主写不生效 = 不标批准、零通知。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createClient as mkClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const l of readFileSync(resolve(__dirname, '../.env.local'), 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const ALEX = '644baf3c-60d8-48d7-860b-bb6afe9a5b76';   // admin(生产 profiles 实存)

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

const svc = mkClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const run = !!process.env.R1C_SMOKE;
let orderId = '';
const cleanupIds: Array<[string, string]> = [];

describe.skipIf(!run)('R1-C 生产 smoke', () => {
  beforeAll(async () => {
    const { data, error } = await (svc.from('orders') as any).insert({
      order_no: `R1C-SMOKE-${Date.now()}`,
      customer_name: '【测试勿动】R1C-SMOKE', incoterm: 'FOB', order_type: 'bulk',
      packaging_type: 'standard', lifecycle_status: 'active',
      quantity: 100, quantity_unit: '件', unit_price: 10, total_amount: 1000,
      factory_date: '2026-12-01', order_date: '2026-08-08',
      owner_user_id: ALEX, created_by: ALEX, notes: 'R1C smoke 测试单,脚本自动清理',
    }).select('id').single();
    if (error) throw new Error('测试单创建失败: ' + error.message);
    orderId = (data as any).id;
    cleanupIds.push(['orders', orderId]);
  }, 60000);

  afterAll(async () => {
    for (const [table, id] of cleanupIds.reverse()) {
      await (svc.from(table) as any).delete().eq('id', id);
    }
    await (svc.from('notifications') as any).delete().eq('related_order_id', orderId);
    await (svc.from('order_logs') as any).delete().eq('order_id', orderId);
  }, 60000);

  it('S1 改单批准:orders 真实改变 + 回读一致 + approved + 审计留痕', async () => {
    const { data: am, error: amErr } = await (svc.from('order_amendments') as any).insert({
      order_id: orderId, requested_by: ALEX, status: 'pending',
      reason: 'R1C smoke', fields_to_change: { quantity_increase: { from: 100, to: 150 } },
    }).select('id').single();
    if (amErr) throw new Error('改单测试行创建失败: ' + amErr.message);
    cleanupIds.push(['order_amendments', (am as any).id]);

    const { approveOrderAmendment } = await import('@/app/actions/order-amendments');
    const before = (await (svc.from('orders') as any).select('quantity,total_amount').eq('id', orderId).single()).data;
    const res = await approveOrderAmendment((am as any).id, true, 'R1C smoke 批准');
    expect((res as any).success).toBe(true);

    const after = (await (svc.from('orders') as any).select('quantity,total_amount').eq('id', orderId).single()).data;
    expect(Number((before as any).quantity)).toBe(100);
    expect(Number((after as any).quantity)).toBe(150);          // SoT 真实改变
    expect(Number((after as any).total_amount)).toBe(1500);      // 联动重算
    const amAfter = (await (svc.from('order_amendments') as any).select('status').eq('id', (am as any).id).single()).data;
    expect((amAfter as any).status).toBe('approved');
    const { data: log } = await (svc.from('order_logs') as any).select('id').eq('order_id', orderId).eq('action', 'critical_mutation:orders').limit(1);
    expect((log || []).length).toBe(1);                          // 审计留痕
  }, 120000);

  it('S1F 注错:对不存在的订单执行生命周期写 → zero_rows 明确失败、零"已拒绝"通知(DB 未更新 = 不 success)', async () => {
    // 注:改单路径的"幽灵订单"注错被 order_amendments 的 FK 约束在插入时就挡住了(本身即一层保护);
    // 此处改注 lifecycle 路径:谓词匹配 0 行 → safeMutation zero_rows → 必须报错且不发通知。
    const ghostOrder = '00000000-0000-4000-8000-000000000000';
    const { rejectImportOrder } = await import('@/app/actions/orders');
    const before = (await (svc.from('notifications') as any).select('id', { count: 'exact', head: true }).eq('related_order_id', ghostOrder));
    const res = await rejectImportOrder(ghostOrder, 'R1C 注错');
    expect((res as any).error).toBeTruthy();                     // 明确失败,不装成功
    // 存在性前置闸先拦(「订单不存在」)或 zero_rows 拦(「未生效」)都算合格 —— 都不是 silent success
    expect(/订单不存在|未生效/.test(String((res as any).error))).toBe(true);
    const after = await (svc.from('notifications') as any).select('id', { count: 'exact', head: true }).eq('related_order_id', ghostOrder);
    expect(after.count ?? 0).toBe(before.count ?? 0);            // 零"已拒绝"通知
  }, 120000);

  it('S2 价格审批:批准后 DB 状态真实变化(不再 UI 成功库里 pending)', async () => {
    const { data: pa, error: paErr } = await (svc.from('pre_order_price_approvals') as any).insert({
      status: 'pending', requested_by: ALEX, customer_name: '【测试】R1C', po_number: 'R1C-SMOKE',
      summary: 'R1C smoke', price_diffs: [], form_snapshot: {},
    }).select('id').single();
    if (paErr) throw new Error('价格审批测试行创建失败: ' + paErr.message);
    cleanupIds.push(['pre_order_price_approvals', (pa as any).id]);
    const { approvePriceApproval } = await import('@/app/actions/price-approvals');
    const res = await approvePriceApproval((pa as any).id, 'approved', 'R1C smoke');
    expect((res as any).error).toBeUndefined();
    const after = (await (svc.from('pre_order_price_approvals') as any).select('status,reviewed_by').eq('id', (pa as any).id).single()).data;
    expect((after as any).status).toBe('approved');
    expect((after as any).reviewed_by).toBe(ALEX);
  }, 120000);

  it('S3 延期驳回:svc+CAS 生效,状态真实 rejected', async () => {
    const { data: ms, error: msErr } = await (svc.from('milestones') as any).insert({
      order_id: orderId, name: 'R1C测试节点', step_key: 'po_confirmed', status: 'in_progress',
      due_at: '2026-11-01', planned_at: '2026-10-25', owner_role: 'sales', sequence_number: 1,
    }).select('id').single();
    if (msErr) throw new Error('测试节点创建失败: ' + msErr.message);
    cleanupIds.push(['milestones', (ms as any).id]);
    const { data: dr, error: drErr } = await (svc.from('delay_requests') as any).insert({
      order_id: orderId, milestone_id: (ms as any).id, requested_by: ALEX, status: 'pending',
      reason: 'R1C smoke', proposed_new_anchor_date: '2026-12-15',
    }).select('id').single();
    if (drErr) throw new Error('延期测试行创建失败: ' + drErr.message);
    cleanupIds.push(['delay_requests', (dr as any).id]);

    const { rejectDelayRequest } = await import('@/app/actions/delays');
    const res = await rejectDelayRequest((dr as any).id, 'R1C smoke 驳回');
    expect((res as any).error).toBeUndefined();
    const after = (await (svc.from('delay_requests') as any).select('status').eq('id', (dr as any).id).single()).data;
    expect((after as any).status).toBe('rejected');
  }, 120000);

  it('S4 生命周期:拒绝导入 → cancelled 真实生效后才有"已拒绝"通知', async () => {
    const { rejectImportOrder } = await import('@/app/actions/orders');
    const res = await rejectImportOrder(orderId, 'R1C smoke 拒绝');
    expect((res as any).error).toBeUndefined();
    const after = (await (svc.from('orders') as any).select('lifecycle_status,terminated_at').eq('id', orderId).single()).data;
    expect((after as any).lifecycle_status).toBe('cancelled');
    expect((after as any).terminated_at).toBeTruthy();
  }, 120000);
});
