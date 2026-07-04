// ============================================================
// 财务系统 → 节拍器 只读 GET 端点的入站鉴权(共享)。
// 签名串统一:HMAC-SHA256("GET:{resource}:{x-timestamp}", INTEGRATION_WEBHOOK_SECRET) hex。
//   列表 /api/integration/orders          → resource = 'orders'
//   单查 /api/integration/orders/{orderNo} → resource = orderNo
// 与财务客户端 src/lib/integration/client.ts 逐字对齐。x-timestamp 5 分钟窗口防重放。
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';

const API_KEY = process.env.INTEGRATION_API_KEY || '';
const WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || '';
const WINDOW_MS = 5 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export type InboundAuthResult =
  | { ok: true }
  | { ok: false; status: number; reason: string };

/** 校验入站只读 GET 请求。resource = 'orders'(列表)或 orderNo(单查)。 */
export function verifyInboundGet(request: Request, resource: string): InboundAuthResult {
  if (!API_KEY || !WEBHOOK_SECRET) return { ok: false, status: 503, reason: 'integration_not_configured' };

  const apiKey = request.headers.get('x-api-key') || '';
  if (!safeEqual(apiKey, API_KEY)) return { ok: false, status: 401, reason: 'bad_api_key' };

  const ts = request.headers.get('x-timestamp') || '';
  const tsMs = Date.parse(ts);
  if (!ts || Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > WINDOW_MS) {
    return { ok: false, status: 401, reason: 'timestamp_expired' };
  }

  const sig = request.headers.get('x-webhook-signature') || '';
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`GET:${resource}:${ts}`).digest('hex');
  if (!safeEqual(sig, expected)) return { ok: false, status: 401, reason: 'bad_signature' };

  return { ok: true };
}

/** 财务现直读的 20 字段(全是 orders 真实列名,零映射)。 */
export const INTEGRATION_ORDER_FIELDS = [
  'id', 'order_no', 'internal_order_no', 'customer_name', 'factory_name',
  'quantity', 'quantity_unit', 'currency', 'total_amount', 'unit_price',
  'incoterm', 'delivery_type', 'order_type', 'lifecycle_status', 'po_number',
  'etd', 'payment_terms', 'notes', 'created_at', 'updated_at',
] as const;
