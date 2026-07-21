// ============================================================
// 临时诊断:/api/admin/diag-procurement (GET)
// 用途:采购/供应链页面整条链路全 0 排查——用 service-role 数真实数据,
//       看采购各表到底有没有数据、在什么状态。诊断完请删除本文件。
// 鉴权:登录 + admin。
// ============================================================

import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAdminRole } from '@/lib/domain/roles';

export const dynamic = 'force-dynamic';

async function countBy(svc: any, table: string, statusCol?: string) {
  try {
    const { count, error } = await (svc.from(table) as any).select('*', { count: 'exact', head: true });
    if (error) return { table, error: error.message };
    const out: any = { table, total: count ?? 0 };
    if (statusCol) {
      const { data } = await (svc.from(table) as any).select(statusCol).limit(2000);
      const byStatus: Record<string, number> = {};
      for (const r of (data || [])) { const k = String((r as any)[statusCol] ?? 'null'); byStatus[k] = (byStatus[k] || 0) + 1; }
      out.byStatus = byStatus;
    }
    return out;
  } catch (e: any) { return { table, error: e?.message }; }
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: '请先登录' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(roles)) return NextResponse.json({ ok: false, error: '仅管理员' }, { status: 403 });

  const svc = createServiceRoleClient();
  const results = await Promise.all([
    countBy(svc, 'procurement_line_items', 'line_status'),   // 队列(待下单/催货/验收)的数据源
    countBy(svc, 'material_plans', 'plan_status'),           // 待采购订单信号源
    countBy(svc, 'procurement_items', 'status'),             // 采购项(核料)
    countBy(svc, 'purchase_orders', 'status'),               // 采购单
    countBy(svc, 'procurement_reconciliations', 'status'),   // 对账
    countBy(svc, 'goods_receipts'),                          // 收货
    countBy(svc, 'material_requirements', 'timing_status'),  // 需求
  ]);
  return NextResponse.json({ ok: true, note: '诊断用,看完请让 Claude 删除本接口', results }, { status: 200 });
}
