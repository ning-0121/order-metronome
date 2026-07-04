// ============================================================
// GET /api/integration/orders?updated_since=<ISO>&limit=200&offset=0
// 财务系统合规拉取通道(替代直连 Supabase):按 updated_at 增量分页拉订单。
// 只读、不改数据、service-role 读(财务需看全量,不受 RLS 限)。
// 鉴权见 lib/integration/inbound-auth.ts(resource='orders')。
// 返回:{ data: [ {20 字段} ] } —— 与财务现直读同一批字段。
// ============================================================

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyInboundGet, INTEGRATION_ORDER_FIELDS } from '@/lib/integration/inbound-auth';

const MAX_LIMIT = 500;

export async function GET(request: Request) {
  const auth = verifyInboundGet(request, 'orders');
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status });

  const url = new URL(request.url);
  const updatedSince = url.searchParams.get('updated_since');
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, MAX_LIMIT);
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    const supabase = createServiceRoleClient();
    let q = (supabase.from('orders') as any)
      .select(INTEGRATION_ORDER_FIELDS.join(', '))
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (updatedSince) {
      const sinceMs = Date.parse(updatedSince);
      if (!Number.isNaN(sinceMs)) q = q.gte('updated_at', new Date(sinceMs).toISOString());
    }
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: data || [], limit, offset, count: (data || []).length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'internal_error' }, { status: 500 });
  }
}
