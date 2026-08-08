/**
 * Executive OS V1 TS1 —— Gregory 缩版端到端生产 smoke(R1TS1_SMOKE=1 才跑)。
 * text → capture → extract → confirm → delegation → submit → verify → CEO 结果 → 反查。
 * 用真实生产表,测试数据自建自清(标题带 TS1-SMOKE)。
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { createClient as mkClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const l of readFileSync(resolve(__dirname, '../.env.local'), 'utf-8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const ALEX = '644baf3c-60d8-48d7-860b-bb6afe9a5b76';   // admin/CEO
const OULU = '4ceaceb2-873a-43f8-bd9a-09ce49df9c41';   // 欧璐 merchandiser

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: any) => f }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }), headers: async () => new Map() }));
let CURRENT = ALEX;
vi.mock('@/lib/supabase/server', async () => {
  const { createClient: mk } = await import('@supabase/supabase-js');
  const client = () => mk(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const withAuth = () => { const c: any = client(); c.auth.getUser = async () => ({ data: { user: { id: CURRENT, email: CURRENT === ALEX ? 'alex@qimoclothing.com' : 'oulu@qimoclothing.com' } }, error: null }); return c; };
  return { createClient: async () => withAuth(), createServiceRoleClient: () => client() };
});

const svc = mkClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const captureIds: string[] = [];
const delegationIds: string[] = [];
let smokeOrderId = '';

afterAll(async () => {
  for (const id of delegationIds) await (svc.from('executive_delegations') as any).delete().eq('id', id);
  for (const id of captureIds) {
    await (svc.from('executive_capture_items') as any).delete().eq('capture_id', id);
    await (svc.from('executive_captures') as any).delete().eq('id', id);
  }
  if (smokeOrderId) {
    await (svc.from('order_financials') as any).delete().eq('order_id', smokeOrderId);
    await (svc.from('orders') as any).delete().eq('id', smokeOrderId);
  }
}, 60000);

describe.skipIf(!process.env.R1TS1_SMOKE)('Executive OS TS1 端到端', () => {
  it('Gregory 缩版全链:确认→分发→提交→核对(<15% rework, ≥15% verified)+ 反查', async () => {
    CURRENT = ALEX;
    const { captureCeoInput } = await import('@/app/actions/exec-capture');
    const { prepareDelegationDrafts, confirmDelegation, submitDelegation, verifyDelegation, traceDelegation } = await import('@/app/actions/exec-delegation');

    // S1 capture
    const cap = await captureCeoInput('让欧璐把 Gregory 当前项目的新报价明天下午前做好,利润低于15%不要发。', `ts1-smoke-${Date.now()}`);
    expect(cap.captureId).toBeTruthy(); captureIds.push(cap.captureId!);

    // S2:直接播种抽取结果(跳过 AI —— 本地无 prod key;AI 质量在部署环境另验)。
    // 播种后 prepareDelegationDrafts / confirm / submit / verify / trace 全部走真实库。
    await (svc.from('executive_capture_items') as any).insert([
      { capture_id: cap.captureId, item_type: 'proposed_delegation', confirmation_status: 'pending', confidence: 0.9,
        structured_payload: { owner_hint: '欧璐', action: 'Gregory 当前项目的新报价', deadline_text: '明天下午前', person: 'Gregory' } },
      { capture_id: cap.captureId, item_type: 'constraint', confirmation_status: 'pending', confidence: 0.95,
        structured_payload: { constraint_type: 'min_margin', constraint_value: 15, restrict: 'send' } },
    ]);
    const prep = await prepareDelegationDrafts(cap.captureId!);
    const draft = (prep.drafts || [])[0];
    expect(draft).toBeTruthy();
    console.log('[TS1] 抽取草案:', JSON.stringify({ title: draft.title, ownerHint: draft.ownerHint, deadlineText: draft.deadlineText, acceptance: draft.acceptanceCriteria, counterparty: draft.counterpartyName }));
    // Gregory 不在客户库 → 应 tentative(未 resolved)
    expect(draft.counterpartyResolved).toBe(false);

    // S3 confirm(CEO 指定欧璐 + 明确 deadline)
    const deadline = new Date(Date.now() + 30 * 3600_000).toISOString();
    const conf = await confirmDelegation({
      captureId: cap.captureId!, captureItemId: draft.id, title: 'Gregory 项目新报价',
      instruction: draft.instruction || '准备新报价', ownerUserId: OULU, deadline,
      acceptanceCriteria: draft.acceptanceCriteria, constraints: draft.constraints,
      counterpartyName: 'Gregory',
    });
    expect(conf.delegationId).toBeTruthy(); delegationIds.push(conf.delegationId!);

    // 建一张 <15% 利润的 smoke 订单,员工提交绑定它
    const { data: ord } = await (svc.from('orders') as any).insert({
      order_no: `TS1-SMOKE-${Date.now()}`, customer_name: '【测试】TS1', incoterm: 'FOB', order_type: 'bulk',
      packaging_type: 'standard', lifecycle_status: 'active', quantity: 100, quantity_unit: '件',
      factory_date: '2026-12-01', order_date: '2026-08-10', owner_user_id: OULU, created_by: OULU,
    }).select('id').single();
    smokeOrderId = (ord as any).id;
    await (svc.from('order_financials') as any).insert({ order_id: smokeOrderId, margin_pct: 12 });   // <15

    // S4 员工提交(切欧璐身份)
    CURRENT = OULU;
    const sub = await submitDelegation(conf.delegationId!, { summary: '报价已做', linkedOrderId: smokeOrderId });
    expect(sub.ok).toBe(true);
    let row = (await (svc.from('executive_delegations') as any).select('delegation_status').eq('id', conf.delegationId!).single()).data;
    expect((row as any).delegation_status).toBe('submitted');   // 提交 ≠ 完成

    // S4 核对(切回 CEO):12% < 15% → rework(不信自报,重读 order_financials)
    CURRENT = ALEX;
    const v1 = await verifyDelegation(conf.delegationId!);
    expect(v1.status).toBe('rework');
    row = (await (svc.from('executive_delegations') as any).select('delegation_status, verification_status, verification_result').eq('id', conf.delegationId!).single()).data;
    expect((row as any).verification_status).toBe('fail');
    console.log('[TS1] <15% 核对:', JSON.stringify((row as any).verification_result));

    // 员工改利润到 16% 重新提交 → verified
    await (svc.from('order_financials') as any).update({ margin_pct: 16 }).eq('order_id', smokeOrderId);
    CURRENT = OULU;
    await submitDelegation(conf.delegationId!, { summary: '已提价重做', linkedOrderId: smokeOrderId });
    CURRENT = ALEX;
    const v2 = await verifyDelegation(conf.delegationId!);
    expect(v2.status).toBe('verified');

    // 反查链:委托 → capture → CEO 原话
    const trace = await traceDelegation(conf.delegationId!);
    expect((trace as any).data.capture.raw_text).toContain('Gregory');
    console.log('[TS1] 反查到 CEO 原话:', (trace as any).data.capture.raw_text.slice(0, 40));
  }, 180000);

  it('need_info:未绑订单/无利润数据 → 不得 verified', async () => {
    CURRENT = ALEX;
    const { captureCeoInput } = await import('@/app/actions/exec-capture');
    const { prepareDelegationDrafts, confirmDelegation, submitDelegation, verifyDelegation } = await import('@/app/actions/exec-delegation');
    const cap = await captureCeoInput('让欧璐做个报价,利润低于15%不要发。', `ts1-ni-${Date.now()}`);
    captureIds.push(cap.captureId!);
    await (svc.from('executive_capture_items') as any).insert([
      { capture_id: cap.captureId, item_type: 'proposed_delegation', confirmation_status: 'pending', confidence: 0.9,
        structured_payload: { owner_hint: '欧璐', action: '做个报价' } },
      { capture_id: cap.captureId, item_type: 'constraint', confirmation_status: 'pending', confidence: 0.9,
        structured_payload: { constraint_type: 'min_margin', constraint_value: 15, restrict: 'send' } },
    ]);
    const prep = await prepareDelegationDrafts(cap.captureId!);
    const draft = (prep.drafts || [])[0];
    const conf = await confirmDelegation({ captureId: cap.captureId!, captureItemId: draft.id, title: '报价 need_info', instruction: '报价', ownerUserId: OULU, deadline: new Date(Date.now() + 3600_000).toISOString(), acceptanceCriteria: draft.acceptanceCriteria, constraints: draft.constraints });
    delegationIds.push(conf.delegationId!);
    CURRENT = OULU;
    await submitDelegation(conf.delegationId!, { summary: '做完了', linkedOrderId: null });   // 不绑订单
    CURRENT = ALEX;
    const v = await verifyDelegation(conf.delegationId!);
    expect(v.status).toBe('submitted');   // need_info 回退,不 verified
    const row = (await (svc.from('executive_delegations') as any).select('verification_status').eq('id', conf.delegationId!).single()).data;
    expect((row as any).verification_status).toBe('need_info');
  }, 180000);
});
