/**
 * 一次性修复：已导入的进行中订单，把选定节点之前的全部标记为 done
 * GET /api/fix-imported-orders
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    // 查所有有 import_current_step 的订单
    const { data: importedOrders } = await (supabase.from('orders') as any)
      .select('id, order_no, import_current_step')
      .not('import_current_step', 'is', null);

    if (!importedOrders || importedOrders.length === 0) {
      return NextResponse.json({ message: 'No imported orders found', fixed: 0 });
    }

    let totalFixed = 0;

    for (const order of importedOrders as any[]) {
      if (!order.import_current_step) continue;

      // 查该订单所有里程碑
      const { data: milestones } = await (supabase.from('milestones') as any)
        .select('id, step_key, status, sequence_number')
        .eq('order_id', order.id)
        .order('sequence_number', { ascending: true });

      if (!milestones || milestones.length === 0) continue;

      // 找到当前步骤的 sequence_number
      const currentMs = milestones.find((m: any) => m.step_key === order.import_current_step);
      if (!currentMs) continue;

      const currentSeq = currentMs.sequence_number;
      let orderFixed = 0;

      for (const ms of milestones as any[]) {
        if (ms.sequence_number < currentSeq && ms.status !== 'done' && ms.status !== '已完成') {
          // 这个节点应该是 done 但还不是
          const { error } = await (supabase.from('milestones') as any)
            .update({ status: 'done', actual_at: ms.due_at || new Date().toISOString() })
            .eq('id', ms.id);
          if (!error) orderFixed++;
        } else if (ms.sequence_number === currentSeq && ms.status !== 'in_progress' && ms.status !== '进行中' && ms.status !== 'done' && ms.status !== '已完成') {
          // 当前节点应该是 in_progress
          await (supabase.from('milestones') as any)
            .update({ status: 'in_progress' })
            .eq('id', ms.id);
          orderFixed++;
        }
      }

      if (orderFixed > 0) {
        totalFixed += orderFixed;
      }
    }

    return NextResponse.json({
      success: true,
      orders_checked: importedOrders.length,
      milestones_fixed: totalFixed,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
