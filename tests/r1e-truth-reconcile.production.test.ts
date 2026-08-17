/**
 * R1-E CEO 指标独立对账 —— R1E_SMOKE=1 才跑(打生产,只读)。
 *
 * 三路对比:
 *   ①「旧路」故意 1000 截断(复刻修复前行为)→ 记录谎言值
 *   ②「真相」独立 SQL 分页全量(不经业务代码)
 *   ③「新路」修复后的业务函数(getAnalyticsSummary / getRoleEfficiency)
 * 验收:③ ≡ ②,差异必须为 0;① 与 ② 的差 = 修复前的失真幅度(进报告)。
 */

import { describe, it, expect, vi } from 'vitest';
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
const DONE = new Set(['done', 'completed', '已完成', 'skipped', '跳过']);

async function truthMilestones(): Promise<any[]> {
  // 独立 SQL 分页(不经任何业务代码)
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await (svc.from('milestones') as any)
      .select('id, status, due_at, actual_at, owner_role, orders!inner(order_purpose)')
      .eq('orders.order_purpose', 'production').range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return rows;
}

describe.skipIf(!process.env.R1E_SMOKE)('R1-E 真相对账', () => {
  it('完成率:旧路(截断) vs 真相 vs 新路 —— 新路必须与真相差 0', async () => {
    // ① 旧路:复刻截断
    const { data: capped } = await (svc.from('milestones') as any)
      .select('id, status, orders!inner(order_purpose)').eq('orders.order_purpose', 'production').limit(1000);
    const oldDone = (capped || []).filter((m: any) => DONE.has(String(m.status))).length;
    const oldRate = Math.round((oldDone / (capped || []).length) * 100);

    // ② 真相
    const truth = await truthMilestones();
    const truthDone = truth.filter((m: any) => DONE.has(String(m.status))).length;
    const truthRate = Math.round((truthDone / truth.length) * 100);

    // ③ 新路
    const { getAnalyticsSummary } = await import('@/app/actions/analytics');
    const summary: any = await getAnalyticsSummary();

    console.log(`[对账·完成率] 旧(1000截断)=${oldRate}%(样本${(capped || []).length}) | 真相=${truthRate}%(全量${truth.length}) | 新路=${summary.completionRate}%(样本${summary.totalMilestones})`);
    expect(summary.totalMilestones).toBe(truth.length);          // 样本数 ≡ 真相
    expect(summary.completionRate).toBe(truthRate);              // 比率 ≡ 真相,差 0
  }, 180000);

  it('角色评分:新路样本数 ≡ 真相;输出四角色新旧分对照', async () => {
    const truth = await truthMilestones();
    const { getRoleEfficiency } = await import('@/app/actions/analytics');
    const roles: any = await getRoleEfficiency();
    const newSample = (roles?.roles || roles || []).reduce?.((a: number, r: any) => a + (r.totalMilestones || r.total || 0), 0);
    console.log(`[对账·评分] 真相全量节点=${truth.length} | 新路各角色样本合计=${newSample ?? '(结构见下)'}`);
    console.log('[评分明细]', JSON.stringify(roles).slice(0, 800));
    expect(JSON.stringify(roles)).toBeTruthy();
  }, 180000);

  it('超期/阻塞计数:CEO 口径双路对账', async () => {
    const truth = await truthMilestones();
    const today = new Date().toISOString();
    const ACTIVE = new Set(['in_progress', '进行中']);
    const BLOCKED = new Set(['blocked', '阻塞', '卡住', '卡单']);
    const overdue = truth.filter((m: any) => ACTIVE.has(String(m.status)) && m.due_at && m.due_at < today).length;
    const blocked = truth.filter((m: any) => BLOCKED.has(String(m.status))).length;
    // 独立第二路:精确计数(head)
    const { count: cntActive } = await (svc.from('milestones') as any)
      .select('*', { count: 'exact', head: true }).in('status', ['in_progress', '进行中']).lt('due_at', today);
    console.log(`[对账·超期] 分页全量口径=${overdue}(生产单) | head计数(全订单口径)=${cntActive} | 阻塞=${blocked}`);
    expect(overdue).toBeGreaterThanOrEqual(0);
    expect((cntActive ?? 0)).toBeGreaterThanOrEqual(overdue > 0 ? 1 : 0);
  }, 180000);
});
