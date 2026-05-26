/**
 * 诊断接口：admin 看延期申请为何为 0
 *
 * 访问：GET /api/admin/diag-delays
 * 需要：已登录的 admin 账号
 * 返回：JSON 报告 — env 是否齐全 / 两种 client 各能看几条 / 当前用户 roles
 *
 * ⚠️ 用完之后建议删除这个文件（含敏感诊断信息）
 */

import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
  };

  // 1. env vars
  report.env = {
    SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  // 2. user session
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ ...report, error: 'not_logged_in' }, { status: 401 });
    }
    report.user = { id: user.id, email: user.email };

    const { data: profile } = await (userClient.from('profiles') as any)
      .select('role, roles')
      .eq('user_id', user.id)
      .single();
    report.profile = profile;

    // 3. user session 视角下能看几条 pending delay
    const { data: userSessionRows, error: userSessionErr } = await (userClient
      .from('delay_requests') as any)
      .select('id')
      .eq('status', 'pending');
    report.user_session_delay_count = userSessionRows?.length ?? null;
    report.user_session_error = userSessionErr?.message ?? null;
  } catch (e: any) {
    report.user_session_error = e?.message;
  }

  // 4. service-role 视角
  try {
    const sr = createServiceRoleClient();
    const { data: srRows, error: srErr } = await (sr
      .from('delay_requests') as any)
      .select('id')
      .eq('status', 'pending');
    report.service_role_delay_count = srRows?.length ?? null;
    report.service_role_error = srErr?.message ?? null;
  } catch (e: any) {
    report.service_role_create_error = e?.message;
  }

  // 5. 完整复现页面查询 — 带 orders() 嵌套 join
  try {
    const sr = createServiceRoleClient();
    const { data: fullRows, error: fullErr } = await (sr
      .from('delay_requests') as any)
      .select('id, order_id, reason, days_delay, status, created_at, requested_by, orders(order_no, customer_name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(100);
    report.full_query_count = fullRows?.length ?? null;
    report.full_query_error = fullErr?.message ?? null;
    report.full_query_first_row = fullRows?.[0] ?? null;
  } catch (e: any) {
    report.full_query_exception = e?.message;
  }

  // 6. 直接调真实的 getPendingApprovals 函数
  try {
    const { getPendingApprovals } = await import('@/lib/services/pending-approvals.service');
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (user) {
      const { data: profile } = await (userClient.from('profiles') as any)
        .select('role, roles').eq('user_id', user.id).single();
      const roles: string[] = (profile as any)?.roles?.length > 0
        ? (profile as any).roles
        : [(profile as any)?.role].filter(Boolean);
      const result = await getPendingApprovals(userClient, { userId: user.id, roles });
      report.service_result = {
        ok: result.ok,
        error: (result as any).error,
        delay_count: result.ok ? result.data.byCategory.delay : null,
        total: result.ok ? result.data.total : null,
        by_category: result.ok ? result.data.byCategory : null,
      };
    }
  } catch (e: any) {
    report.service_exception = e?.message;
    report.service_stack = e?.stack?.slice(0, 500);
  }

  return NextResponse.json(report, { status: 200 });
}
