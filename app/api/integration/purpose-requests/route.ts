// ============================================================
// GET /api/integration/purpose-requests
// 财务系统合规拉取「订单用途变更」待审批申请(替代直连 Supabase)。
// 只读、service-role(财务需看全量,不受 RLS)。鉴权见 lib/integration/inbound-auth.ts。
// 签名串:HMAC-SHA256("GET:purpose-requests:{x-timestamp}", INTEGRATION_WEBHOOK_SECRET)。
// 返回:{ data: [{ id, order_id, order_no, internal_order_no, customer_name,
//                 from_purpose, to_purpose, reason, requester_name, created_at }] }
// ============================================================

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyInboundGet } from '@/lib/integration/inbound-auth';

export async function GET(request: Request) {
  const auth = verifyInboundGet(request, 'purpose-requests');
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status });

  try {
    const svc = createServiceRoleClient();
    const { data: reqs, error } = await (svc.from('order_purpose_change_requests') as any)
      .select('id, order_id, from_purpose, to_purpose, reason, requested_by, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (reqs || []) as any[];
    if (rows.length === 0) return NextResponse.json({ data: [] });

    // 补订单信息 + 申请人名(一次性批量)
    const orderIds = [...new Set(rows.map(r => r.order_id))];
    const userIds = [...new Set(rows.map(r => r.requested_by))];
    const [{ data: orders }, { data: profs }] = await Promise.all([
      (svc.from('orders') as any).select('id, order_no, internal_order_no, customer_name').in('id', orderIds),
      (svc.from('profiles') as any).select('user_id, full_name, name, email').in('user_id', userIds),
    ]);
    const orderById = new Map((orders || []).map((o: any) => [o.id, o]));
    const nameById = new Map((profs || []).map((p: any) => [p.user_id, p.full_name || p.name || p.email || '业务']));

    const data = rows.map(r => {
      const o: any = orderById.get(r.order_id) || {};
      return {
        id: r.id,
        order_id: r.order_id,
        order_no: o.order_no ?? null,
        internal_order_no: o.internal_order_no ?? null,
        customer_name: o.customer_name ?? null,
        from_purpose: r.from_purpose,
        to_purpose: r.to_purpose,
        reason: r.reason,
        requester_name: nameById.get(r.requested_by) || '业务',
        created_at: r.created_at,
      };
    });
    return NextResponse.json({ data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'internal_error' }, { status: 500 });
  }
}
