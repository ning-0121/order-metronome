// ============================================================
// GET /api/integration/orders?updated_since=<ISO>&limit=200&offset=0
// 财务系统合规拉取通道(替代直连 Supabase):按 updated_at 增量分页拉订单。
// 只读、不改数据、service-role 读(财务需看全量,不受 RLS 限)。
//
// 鉴权(与单查 /api/integration/orders/{orderNo} 同套):
//   x-api-key            = INTEGRATION_API_KEY
//   x-timestamp          = 请求时刻 ISO(5 分钟窗口,防重放)
//   x-webhook-signature  = HMAC-SHA256("GET:orders:{x-timestamp}", INTEGRATION_WEBHOOK_SECRET) hex
//
// 返回:{ data: [ {20 字段} ] } —— 与财务现直读同一批字段。
// ============================================================

import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

const API_KEY = process.env.INTEGRATION_API_KEY || '';
const WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || '';
const WINDOW_MS = 5 * 60 * 1000;
const MAX_LIMIT = 500;

// 财务现直读的 20 字段(全部是 orders 真实列名,零映射)
const FIELDS = [
  'id', 'order_no', 'internal_order_no', 'customer_name', 'factory_name',
  'quantity', 'quantity_unit', 'currency', 'total_amount', 'unit_price',
  'incoterm', 'delivery_type', 'order_type', 'lifecycle_status', 'po_number',
  'etd', 'payment_terms', 'notes', 'created_at', 'updated_at',
] as const;

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function unauthorized(reason: string) {
  return NextResponse.json({ error: 'Unauthorized', reason }, { status: 401 });
}

export async function GET(request: Request) {
  if (!API_KEY || !WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'integration_not_configured' }, { status: 503 });
  }

  // 1. API Key
  const apiKey = request.headers.get('x-api-key') || '';
  if (apiKey.length !== API_KEY.length || !safeEqualHex(Buffer.from(apiKey).toString('hex'), Buffer.from(API_KEY).toString('hex'))) {
    return unauthorized('bad_api_key');
  }

  // 2. 时间戳窗口(防重放)
  const ts = request.headers.get('x-timestamp') || '';
  const tsMs = Date.parse(ts);
  if (!ts || Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > WINDOW_MS) {
    return unauthorized('timestamp_expired');
  }

  // 3. HMAC 签名:HMAC-SHA256("GET:orders:{timestamp}", secret)
  const sig = request.headers.get('x-webhook-signature') || '';
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`GET:orders:${ts}`).digest('hex');
  if (!safeEqualHex(sig, expected)) {
    return unauthorized('bad_signature');
  }

  // 4. 参数
  const url = new URL(request.url);
  const updatedSince = url.searchParams.get('updated_since');
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, MAX_LIMIT);
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  // 5. 只读拉取(service-role;财务看全量)。按 updated_at 增量,稳定分页。
  try {
    const supabase = createServiceRoleClient();
    let q = (supabase.from('orders') as any)
      .select(FIELDS.join(', '))
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
