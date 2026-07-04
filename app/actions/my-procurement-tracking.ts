'use server';

/**
 * 业务侧「我的采购追踪」(2026-07-04)—— 首页 dashboard 板块。
 * 把每单的采购进度共享表汇总到业务自己名下:我负责的每个活跃订单 → 采购执行进度
 * (到货率 / 已下单 / 催货)+ 到期的采购提醒待办。纯派生只读,不写库,天然无底价。
 */

import { createClient } from '@/lib/supabase/server';

export interface MyProcOrderRow {
  order_id: string;
  order_no: string | null;
  customer_name: string | null;
  factory_date: string | null;
  total_lines: number;
  received_lines: number;      // 已到货行(line_status arrived/received 或 received_qty≥ordered_qty)
  ordered_lines: number;       // 已下单未到齐
  pending_lines: number;       // 未下单
  po_count: number;
  reminder_open: number;       // 未完成的提醒数(pending/notified)
  reminder_due: number;        // 其中已到期(remind_at ≤ 今天且 pending)
}

export async function getMyProcurementTracking(): Promise<{ data?: MyProcOrderRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 我负责的活跃订单(负责人或创建者)
  const { data: orders, error: oErr } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_date, lifecycle_status, owner_user_id, created_by')
    .or(`owner_user_id.eq.${user.id},created_by.eq.${user.id}`)
    .not('lifecycle_status', 'in', '("completed","cancelled","archived","已完成","已取消","已归档")');
  if (oErr) return { error: oErr.message };
  const myOrders = (orders || []) as any[];
  if (myOrders.length === 0) return { data: [] };
  const orderIds = myOrders.map((o) => o.id);

  // 采购执行行(按 order_id)——line_status / 收货量;顺带收集其采购单 id
  const { data: liRaw } = await (supabase.from('procurement_line_items') as any)
    .select('order_id, line_status, ordered_qty, received_qty, purchase_order_id')
    .in('order_id', orderIds);
  const lines = (liRaw || []) as any[];

  // 采购提醒(未完成的),按采购单归到订单
  const poIds = [...new Set(lines.map((l) => l.purchase_order_id).filter(Boolean))];
  const poToOrders = new Map<string, Set<string>>();
  for (const l of lines) {
    if (!l.purchase_order_id) continue;
    if (!poToOrders.has(l.purchase_order_id)) poToOrders.set(l.purchase_order_id, new Set());
    poToOrders.get(l.purchase_order_id)!.add(l.order_id);
  }
  const today = new Date().toISOString().slice(0, 10);
  const remOpenByOrder = new Map<string, number>();
  const remDueByOrder = new Map<string, number>();
  if (poIds.length > 0) {
    const { data: rems } = await (supabase.from('po_reminders') as any)
      .select('purchase_order_id, status, remind_at')
      .in('purchase_order_id', poIds)
      .in('status', ['pending', 'notified']);
    for (const r of (rems || []) as any[]) {
      const oids = poToOrders.get(r.purchase_order_id);
      if (!oids) continue;
      for (const oid of oids) {
        remOpenByOrder.set(oid, (remOpenByOrder.get(oid) || 0) + 1);
        if (r.status === 'pending' && r.remind_at <= today) remDueByOrder.set(oid, (remDueByOrder.get(oid) || 0) + 1);
      }
    }
  }

  // 按订单汇总执行行
  const agg = new Map<string, { total: number; received: number; ordered: number; pending: number; pos: Set<string> }>();
  for (const oid of orderIds) agg.set(oid, { total: 0, received: 0, ordered: 0, pending: 0, pos: new Set() });
  for (const l of lines) {
    const a = agg.get(l.order_id); if (!a) continue;
    a.total++;
    if (l.purchase_order_id) a.pos.add(l.purchase_order_id);
    const ord = Number(l.ordered_qty) || 0;
    const rec = Number(l.received_qty) || 0;
    const st = String(l.line_status || '');
    if (st === 'received' || st === 'arrived' || (ord > 0 && rec >= ord)) a.received++;
    else if (st === 'ordered' || st === 'in_transit' || l.purchase_order_id) a.ordered++;
    else a.pending++;
  }

  const rows: MyProcOrderRow[] = myOrders.map((o) => {
    const a = agg.get(o.id)!;
    return {
      order_id: o.id, order_no: o.order_no, customer_name: o.customer_name, factory_date: o.factory_date,
      total_lines: a.total, received_lines: a.received, ordered_lines: a.ordered, pending_lines: a.pending,
      po_count: a.pos.size,
      reminder_open: remOpenByOrder.get(o.id) || 0,
      reminder_due: remDueByOrder.get(o.id) || 0,
    };
  })
  // 只留有采购活动或有提醒的单;按到期提醒>有采购>工厂期 排序
  .filter((r) => r.total_lines > 0 || r.reminder_open > 0)
  .sort((a, b) => (b.reminder_due - a.reminder_due) || (a.factory_date || '9999').localeCompare(b.factory_date || '9999'));

  return { data: rows };
}
