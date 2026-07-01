// POST /api/os/ignite-po  { poId, operational }
// 临时点火端点：把 PO → Order 激活流对外触发。**无业务逻辑**，仅转发 createOrderFromPO。
// auth + Kernel 门控 + snapshot 硬门全在 createOrderFromPO 内（本路由不判断、不建单、不越权）。
// 中间件已保护 /api/os/*（需登录）。

import { NextResponse, type NextRequest } from 'next/server';
import { createOrderFromPO } from '@/app/actions/order-from-po';

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const poId = body?.poId;
  if (!poId || typeof poId !== 'string') {
    return NextResponse.json({ ok: false, error: 'poId_required' }, { status: 400 });
  }

  // Order 自有运营字段（PO/快照不拥有 —— Contract §三；createOrder 硬校验必填项）
  const op = body?.operational;
  if (!op?.internal_order_no || !op?.order_type || !op?.factory_date || !op?.incoterm) {
    return NextResponse.json(
      { ok: false, error: 'operational_required: internal_order_no, order_type, factory_date, incoterm' },
      { status: 400 },
    );
  }

  const res = await createOrderFromPO({ customerPoId: poId, operational: op });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
