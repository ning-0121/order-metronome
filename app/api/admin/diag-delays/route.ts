/** 临时诊断 v2 — 验证新 collectDelayRequests 是否真的部署 + 工作 */
import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    code_version: 'v2-no-nested-join',  // 用来确认部署的代码版本
  };

  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ ...report, error: 'not_logged_in' }, { status: 401 });
    report.user_email = user.email;

    // === 完整复现新 collectDelayRequests 的流程 ===
    const sr = createServiceRoleClient();

    // Step 1: 查 delays（不带 join）
    const { data: delays, error: delaysError } = await (sr.from('delay_requests') as any)
      .select('id, order_id, reason, days_delay, status, created_at, requested_by')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(100);
    report.step1_delays_count = delays?.length ?? null;
    report.step1_error = delaysError?.message ?? null;
    report.step1_first_3 = delays?.slice(0, 3) ?? null;

    if (delays && delays.length > 0) {
      // Step 2: 查 orders
      const orderIds = Array.from(new Set((delays as any[]).map((d) => d.order_id).filter(Boolean)));
      report.step2_unique_order_ids_count = orderIds.length;

      const { data: orders, error: ordersError } = await (sr.from('orders') as any)
        .select('id, order_no, customer_name')
        .in('id', orderIds);
      report.step2_orders_count = orders?.length ?? null;
      report.step2_error = ordersError?.message ?? null;
    }

    // === 直接调用 service ===
    const { getPendingApprovals } = await import('@/lib/services/pending-approvals.service');
    const { data: profile } = await (userClient.from('profiles') as any)
      .select('role, roles').eq('user_id', user.id).single();
    const roles: string[] = (profile as any)?.roles?.length > 0
      ? (profile as any).roles
      : [(profile as any)?.role].filter(Boolean);
    const result = await getPendingApprovals(userClient, { userId: user.id, roles });
    report.service_result = {
      ok: result.ok,
      delay_count: result.ok ? result.data.byCategory.delay : null,
      by_category: result.ok ? result.data.byCategory : null,
    };
  } catch (e: any) {
    report.exception = e?.message;
    report.stack = e?.stack?.slice(0, 600);
  }

  return NextResponse.json(report, { status: 200 });
}
