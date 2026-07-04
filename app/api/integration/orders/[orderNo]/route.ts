// ============================================================
// GET /api/integration/orders/{orderNo}
// 财务系统单查订单(按 order_no 或 internal_order_no)。只读、service-role。
// 鉴权见 lib/integration/inbound-auth.ts(resource = orderNo,签名串 "GET:{orderNo}:{ts}")。
// 返回:{ data: {20 字段} } 命中;404 未命中。字段与列表端点同一批。
// ============================================================

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyInboundGet, INTEGRATION_ORDER_FIELDS } from '@/lib/integration/inbound-auth';

export async function GET(request: Request, ctx: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await ctx.params;
  const decoded = decodeURIComponent(orderNo || '');

  // 签名 resource = 原始路径段(与财务客户端 encodeURIComponent 前的 orderNo 一致)
  const auth = verifyInboundGet(request, decoded);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status });

  // 只允许安全字符,防 PostgREST or() 过滤注入(逗号/括号/引号)
  if (!decoded || !/^[A-Za-z0-9._-]+$/.test(decoded)) return NextResponse.json({ error: 'bad_order_no' }, { status: 400 });

  try {
    const supabase = createServiceRoleClient();
    // 按 order_no 或 internal_order_no 命中(财务可能用任一双号查)
    const { data, error } = await (supabase.from('orders') as any)
      .select(INTEGRATION_ORDER_FIELDS.join(', '))
      .or(`order_no.eq.${decoded},internal_order_no.eq.${decoded}`)
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'internal_error' }, { status: 500 });
  }
}
