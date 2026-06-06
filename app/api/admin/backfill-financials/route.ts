// ============================================================
// GET /api/admin/backfill-financials          → dry-run（默认，只列订单不写库）
// GET /api/admin/backfill-financials?execute=1 → 执行回填
// 对「active 且 缺 order_financials 或 确认行<4」的订单，复用 initOrderFinancials 补建。
// ⚠️ 只写 order_financials + 4 个确认行；不碰 lifecycle_status / milestones / 审批状态。
// ⚠️ 临时路由，回填完成后删除。
// ============================================================

import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAdminRole } from '@/lib/domain/roles';
import { initOrderFinancials } from '@/app/actions/order-financials';

export async function GET(request: Request) {
  // ── 鉴权：仅 admin ──
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(roles)) return NextResponse.json({ error: '仅管理员可运行' }, { status: 403 });

  const execute = new URL(request.url).searchParams.get('execute') === '1';

  // ── 找目标订单（service-role 读，避免 RLS 漏看）──
  const sys = createServiceRoleClient();
  const [ordersRes, finRes, confRes] = await Promise.all([
    (sys.from('orders') as any).select('id, order_no, lifecycle_status'),
    (sys.from('order_financials') as any).select('order_id'),
    (sys.from('order_confirmations') as any).select('order_id, module'),
  ]);
  const orders: any[] = ordersRes.data || [];
  const finIds = new Set((finRes.data || []).map((f: any) => f.order_id));
  const confCount = new Map<string, number>();
  for (const c of (confRes.data || [])) confCount.set(c.order_id, (confCount.get(c.order_id) || 0) + 1);

  const isActive = (s: string) => !['completed', '已完成', 'cancelled', '已取消', 'draft'].includes(s);

  const targets = orders.filter(o => {
    if (!isActive(o.lifecycle_status)) return false;
    const missingFin = !finIds.has(o.id);
    const incompleteConf = (confCount.get(o.id) || 0) < 4;
    return missingFin || incompleteConf;
  }).map(o => ({
    id: o.id,
    order_no: o.order_no,
    missing_financials: !finIds.has(o.id),
    confirmations: confCount.get(o.id) || 0,
  }));

  // ── dry-run：只列，不写 ──
  if (!execute) {
    return NextResponse.json({
      mode: 'dry-run',
      hint: '确认无误后，访问 ?execute=1 执行回填',
      target_count: targets.length,
      targets,
    });
  }

  // ── execute：逐单复用 initOrderFinancials ──
  const results: Array<{ order_no: string; ok: boolean; error?: string }> = [];
  for (const t of targets) {
    try {
      const r = await initOrderFinancials(t.id);
      results.push({ order_no: t.order_no, ok: !r.error, error: r.error });
    } catch (e: any) {
      results.push({ order_no: t.order_no, ok: false, error: e?.message || 'exception' });
    }
  }
  return NextResponse.json({
    mode: 'execute',
    total: results.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  });
}
