/**
 * 成本监控 Cron — 每 6 小时
 *
 * 检查所有进行中订单的成本超标情况：
 * 1. 面料采购总量 vs 预算 → 超 5% 发通知
 * 2. 加工费报价 vs 内部估价 → 超 15% 发通知
 * 3. 去重：同一订单同一类型 24 小时内不重复通知
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // 查所有有成本基线的进行中订单
    const { data: baselines } = await supabase
      .from('order_cost_baseline')
      .select('order_id, budget_fabric_kg, cmt_internal_estimate, cmt_factory_quote');

    if (!baselines || baselines.length === 0) {
      return NextResponse.json({ success: true, message: 'No baselines to check', alerts: 0 });
    }

    let alertsSent = 0;

    for (const baseline of baselines as any[]) {
      const orderId = baseline.order_id;

      // 检查订单是否还在进行中
      const { data: order } = await supabase
        .from('orders')
        .select('id, order_no, lifecycle_status')
        .eq('id', orderId)
        .single();
      if (!order || ['completed', '已完成', 'cancelled', '已取消'].includes((order as any).lifecycle_status)) continue;

      const orderNo = (order as any).order_no || '?';

      // ── 面料采购 vs 预算 ──
      if (baseline.budget_fabric_kg) {
        const { data: fabricItems } = await supabase
          .from('procurement_line_items')
          .select('ordered_qty')
          .eq('order_id', orderId)
          .eq('category', 'fabric');

        const totalFabricKg = (fabricItems || []).reduce((s: number, r: any) => s + (r.ordered_qty || 0), 0);
        if (totalFabricKg > 0) {
          const overPct = ((totalFabricKg - baseline.budget_fabric_kg) / baseline.budget_fabric_kg) * 100;
          if (overPct > 5) {
            const alertIcon = overPct > 10 ? '🔴' : '🟡';
            // 去重：24 小时内同一订单不重复
            const { count } = await supabase
              .from('notifications')
              .select('id', { count: 'exact', head: true })
              .eq('related_order_id', orderId)
              .eq('type', 'cost_alert_fabric')
              .gte('created_at', oneDayAgo);
            if (!count || count === 0) {
              await notifyStakeholders(supabase, orderId, orderNo, 'cost_alert_fabric',
                `${alertIcon} ${orderNo} 面料采购超预算 ${overPct.toFixed(1)}%`,
                `面料采购 ${totalFabricKg.toFixed(1)} KG，预算 ${baseline.budget_fabric_kg.toFixed(1)} KG`);
              alertsSent++;
            }
          }
        }
      }

      // ── 加工费报价 vs 内部估价 ──
      if (baseline.cmt_internal_estimate && baseline.cmt_factory_quote) {
        const cmtDiff = ((baseline.cmt_factory_quote - baseline.cmt_internal_estimate) / baseline.cmt_internal_estimate) * 100;
        if (cmtDiff > 15) {
          const { count } = await supabase
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('related_order_id', orderId)
            .eq('type', 'cost_alert_cmt')
            .gte('created_at', oneDayAgo);
          if (!count || count === 0) {
            await notifyStakeholders(supabase, orderId, orderNo, 'cost_alert_cmt',
              `🔴 ${orderNo} 加工费超内部估价 ${cmtDiff.toFixed(1)}%`,
              `工厂报价 ¥${baseline.cmt_factory_quote}，内部估价 ¥${baseline.cmt_internal_estimate}`);
            alertsSent++;
          }
        }
      }
    }

    return NextResponse.json({ success: true, checked: baselines.length, alertsSent });
  } catch (err: any) {
    console.error('[cost-monitoring]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

async function notifyStakeholders(
  supabase: any,
  orderId: string,
  orderNo: string,
  type: string,
  title: string,
  message: string,
) {
  // 通知所有 admin + finance 角色
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, role, roles')
    .or("role.eq.admin,role.eq.finance,roles.cs.{admin},roles.cs.{finance}");

  const userIds = new Set<string>();
  for (const p of (profiles || []) as any[]) {
    userIds.add(p.user_id);
  }

  for (const userId of userIds) {
    await supabase.from('notifications').insert({
      user_id: userId,
      type,
      title,
      message,
      related_order_id: orderId,
      status: 'unread',
    });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
