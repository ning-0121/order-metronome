/**
 * 一次性批量回填 — 为所有缺少采购跟踪共享表的订单自动创建默认条目
 *
 * 调用方式（管理员执行一次即可）：
 *   POST /api/backfill-procurement
 *   Header: Authorization: Bearer {CRON_SECRET}
 *
 * 逻辑：
 *   1. 扫描所有含 procurement_order_placed 里程碑的订单（生产单）
 *   2. 对每个订单检查 procurement_tracking 是否已有数据
 *   3. 没有 → 插入 4 条默认条目（面料/辅料/吊牌洗标/包装）
 *   4. 已有 → 跳过（幂等）
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

const DEFAULT_ITEMS = [
  { category: 'fabric',    item_name: '大货面料',  status: 'pending' },
  { category: 'trims',     item_name: '拉链/纽扣', status: 'pending' },
  { category: 'trims',     item_name: '吊牌/洗标', status: 'pending' },
  { category: 'packaging', item_name: '包装袋/纸箱', status: 'pending' },
];

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 });
  }

  const supabase = createClient(url, serviceKey);

  // 1. 获取所有含采购节点的订单（生产单才有 procurement_order_placed）
  const { data: milestoneOrders, error: msErr } = await supabase
    .from('milestones')
    .select('order_id')
    .eq('step_key', 'procurement_order_placed');

  if (msErr) {
    return NextResponse.json({ error: msErr.message }, { status: 500 });
  }

  const orderIds = [...new Set((milestoneOrders || []).map((m: any) => m.order_id as string))];
  console.log(`[backfill-procurement] 共找到 ${orderIds.length} 个含采购节点的订单`);

  let skipped = 0;
  let created = 0;
  let failed = 0;
  const failedOrders: string[] = [];

  for (const orderId of orderIds) {
    try {
      // 2. 检查是否已有数据（幂等）
      const { data: existing } = await supabase
        .from('procurement_tracking' as any)
        .select('id')
        .eq('order_id', orderId)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      // 3. 插入 4 条默认条目
      const rows = DEFAULT_ITEMS.map(d => ({
        order_id: orderId,
        ...d,
        updated_by_name: 'System',
      }));

      const { error: insertErr } = await supabase
        .from('procurement_tracking' as any)
        .insert(rows);

      if (insertErr) {
        console.warn(`[backfill-procurement] 订单 ${orderId} 插入失败:`, insertErr.message);
        failed++;
        failedOrders.push(orderId);
      } else {
        created++;
      }
    } catch (err: any) {
      failed++;
      failedOrders.push(orderId);
      console.warn(`[backfill-procurement] 订单 ${orderId} 异常:`, err?.message);
    }
  }

  console.log(`[backfill-procurement] 完成 — 新建: ${created}, 跳过: ${skipped}, 失败: ${failed}`);

  return NextResponse.json({
    success: true,
    total: orderIds.length,
    created,   // 新建了共享表格的订单数
    skipped,   // 已有数据跳过的订单数
    failed,    // 失败数
    failedOrders: failedOrders.length > 0 ? failedOrders : undefined,
  });
}

// GET 也支持（方便浏览器直接访问测试）
export async function GET(req: Request) {
  return POST(req);
}
