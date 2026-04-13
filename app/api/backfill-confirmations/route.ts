/**
 * 一次性 API：批量修复老订单的确认链
 * 访问：GET /api/backfill-confirmations（需登录 admin）
 *
 * 两步：
 * 1. 没有确认链记录的订单 → 创建（status=confirmed）
 * 2. 有确认链但 status=not_started 的 → 更新为 confirmed
 */

import { backfillConfirmationsForExistingOrders } from '@/app/actions/order-financials';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Step 1: 创建缺失的记录
    const result = await backfillConfirmationsForExistingOrders();

    // Step 2: 把所有 not_started 的记录改为 confirmed（老订单）
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let fixed = 0;
    if (user) {
      const { data: notStarted } = await (supabase.from('order_confirmations') as any)
        .select('id, order_id, module')
        .eq('status', 'not_started');

      if (notStarted && notStarted.length > 0) {
        const { error } = await (supabase.from('order_confirmations') as any)
          .update({
            status: 'confirmed',
            customer_confirmed: true,
            confirmed_at: new Date().toISOString(),
            confirmed_by: user.id,
            notes: '系统自动补建（老订单默认已确认）',
          })
          .eq('status', 'not_started');

        if (!error) fixed = notStarted.length;
      }
    }

    return NextResponse.json({ ...result, fixed_not_started: fixed });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
