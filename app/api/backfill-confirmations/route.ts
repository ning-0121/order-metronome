/**
 * 一次性 API：批量初始化老订单的确认链 + 经营数据
 * 访问：GET /api/backfill-confirmations（需登录 admin）
 */

import { backfillConfirmationsForExistingOrders } from '@/app/actions/order-financials';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const result = await backfillConfirmationsForExistingOrders();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
