'use server';

/**
 * 剩余货物(分批出货未出完的部分)—— 精确到每款每色。
 * 剩余(某款色)= order_line_items.qty_pcs − Σ(已出货/已交付批次里该行分配的件数)。
 * 位置 = 订单生产工厂 order.factory_name。业务员可一键导出跨订单剩余清单。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';

const SHIPPED = new Set(['shipped', 'delivered']);
const SALES_ROLES = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'];
const TERMINAL = ['completed', '已完成', 'cancelled', '已取消', 'archived', '已归档', '已复盘'];

async function rolesOf(supabase: any, userId: string): Promise<string[]> {
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  return (p as any)?.roles?.length > 0 ? (p as any).roles : [(p as any)?.role].filter(Boolean);
}

const colorOf = (l: any) => l.color_cn || l.color_en || '';

/** 某订单的每款色剩余(供出货 tab 显示 + 导出复用)。 */
export async function getOrderLeftover(orderId: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };

  const { data: lines } = await (supabase.from('order_line_items') as any)
    .select('id, style_no, product_name, color_cn, color_en, qty_pcs').eq('order_id', orderId).order('line_no', { ascending: true });
  const { data: batches } = await (supabase.from('shipment_batches') as any).select('id, status').eq('order_id', orderId);
  const shippedBatchIds = new Set(((batches || []) as any[]).filter((b) => SHIPPED.has(b.status)).map((b) => b.id));

  const shippedByLine = new Map<string, number>();
  try {
    const { data: items } = await (supabase.from('shipment_batch_items') as any).select('batch_id, order_line_item_id, qty_pcs').eq('order_id', orderId);
    for (const it of (items || []) as any[]) {
      if (!shippedBatchIds.has(it.batch_id)) continue; // 只算已出货/已交付批次
      shippedByLine.set(it.order_line_item_id, (shippedByLine.get(it.order_line_item_id) || 0) + (Number(it.qty_pcs) || 0));
    }
  } catch { /* 迁移未执行:无分配数据 → 剩余=全量 */ }

  const rows = ((lines || []) as any[]).map((l) => {
    const ordered = Number(l.qty_pcs) || 0;
    const shipped = shippedByLine.get(l.id) || 0;
    return { line_id: l.id, style_no: l.style_no || '', product_name: l.product_name || '', color: colorOf(l), ordered, shipped, leftover: ordered - shipped };
  });
  return { data: rows };
}

/** 批次款色分配编辑器数据:该订单每款色 + 本批已分配件数 + 剩余(不含本批)。 */
export async function getBatchAllocation(orderId: string, batchId: string): Promise<{ data?: { lines: any[] }; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };

  const { data: lines } = await (supabase.from('order_line_items') as any)
    .select('id, style_no, product_name, color_cn, color_en, qty_pcs').eq('order_id', orderId).order('line_no', { ascending: true });
  const { data: batches } = await (supabase.from('shipment_batches') as any).select('id, status').eq('order_id', orderId);
  const shippedBatchIds = new Set(((batches || []) as any[]).filter((b) => SHIPPED.has(b.status)).map((b) => b.id));

  const thisBatch = new Map<string, number>();
  const shippedOther = new Map<string, number>();
  try {
    const { data: items } = await (supabase.from('shipment_batch_items') as any).select('batch_id, order_line_item_id, qty_pcs').eq('order_id', orderId);
    for (const it of (items || []) as any[]) {
      if (it.batch_id === batchId) thisBatch.set(it.order_line_item_id, (thisBatch.get(it.order_line_item_id) || 0) + (Number(it.qty_pcs) || 0));
      else if (shippedBatchIds.has(it.batch_id)) shippedOther.set(it.order_line_item_id, (shippedOther.get(it.order_line_item_id) || 0) + (Number(it.qty_pcs) || 0));
    }
  } catch { /* 迁移未执行 */ }

  const rows = ((lines || []) as any[]).map((l) => {
    const ordered = Number(l.qty_pcs) || 0;
    return {
      line_id: l.id, style_no: l.style_no || '', product_name: l.product_name || '', color: colorOf(l),
      ordered, qty_in_batch: thisBatch.get(l.id) || 0,
      remaining_excl_batch: ordered - (shippedOther.get(l.id) || 0), // 本批可分配上限参考(其它已出货批之外)
    };
  });
  return { data: { lines: rows } };
}

/** 记录某出货批次的款色分配(整批覆盖写)。业务角色可改。 */
export async function setBatchAllocation(batchId: string, items: Array<{ order_line_item_id: string; qty: number }>): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some((r) => SALES_ROLES.includes(r))) return { error: '仅业务/跟单/管理员可分配出货款色' };

  const { data: batch } = await (supabase.from('shipment_batches') as any).select('order_id').eq('id', batchId).maybeSingle();
  if (!batch) return { error: '出货批次不存在' };
  const orderId = (batch as any).order_id;
  const svc = createServiceRoleClient();
  const { error: delErr } = await (svc.from('shipment_batch_items') as any).delete().eq('batch_id', batchId);
  if (delErr) return { error: delErr.message };
  const rows = (items || []).filter((i) => i.order_line_item_id && Number(i.qty) > 0)
    .map((i) => ({ batch_id: batchId, order_id: orderId, order_line_item_id: i.order_line_item_id, qty_pcs: Math.round(Number(i.qty)) }));
  if (rows.length > 0) {
    const { error: insErr } = await (svc.from('shipment_batch_items') as any).insert(rows);
    if (insErr) return { error: insErr.message };
  }
  return { ok: true };
}

/** 业务员一键导出剩余货物(跨订单;精确到款色 + 所属订单 + 生产工厂)。返回 Excel base64。 */
export async function exportLeftoverGoods(): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some((r) => SALES_ROLES.includes(r))) return { error: '仅业务/跟单/管理员可导出剩余货物' };
  const canSeeAll = hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS') || roles.includes('admin');

  const svc = createServiceRoleClient();
  // 订单范围:管理层看全部活跃单;业务只看自己 owner/created 的活跃单
  let oq = (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, owner_user_id, created_by')
    .not('lifecycle_status', 'in', `(${TERMINAL.map((t) => `"${t}"`).join(',')})`);
  if (!canSeeAll) oq = oq.or(`owner_user_id.eq.${user.id},created_by.eq.${user.id}`);
  const { data: orders } = await oq;
  const list = (orders || []) as any[];
  if (list.length === 0) return { error: '没有你负责的活跃订单' };
  const orderIds = list.map((o) => o.id);
  const orderById = new Map(list.map((o) => [o.id, o]));

  // 一次性批量取款色 + 批次 + 分配(无 N+1)
  const [{ data: lines }, { data: batches }] = await Promise.all([
    (svc.from('order_line_items') as any).select('id, order_id, style_no, product_name, color_cn, color_en, qty_pcs').in('order_id', orderIds),
    (svc.from('shipment_batches') as any).select('id, order_id, status').in('order_id', orderIds),
  ]);
  const shippedBatchIds = new Set(((batches || []) as any[]).filter((b) => SHIPPED.has(b.status)).map((b) => b.id));
  const shippedByLine = new Map<string, number>();
  try {
    const { data: items } = await (svc.from('shipment_batch_items') as any).select('batch_id, order_line_item_id, qty_pcs').in('order_id', orderIds);
    for (const it of (items || []) as any[]) {
      if (!shippedBatchIds.has(it.batch_id)) continue;
      shippedByLine.set(it.order_line_item_id, (shippedByLine.get(it.order_line_item_id) || 0) + (Number(it.qty_pcs) || 0));
    }
  } catch { /* 迁移未执行 → 剩余=全量 */ }

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('剩余货物');
  const headers = ['订单号', '内部单号', '客户', '生产工厂', '款号', '产品', '颜色', '订单件', '已出', '剩余'];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  [16, 18, 16, 14, 14, 18, 12, 10, 10, 10].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  let totalLeftover = 0;
  const sorted = ((lines || []) as any[])
    .map((l) => {
      const ordered = Number(l.qty_pcs) || 0;
      const leftover = ordered - (shippedByLine.get(l.id) || 0);
      return { l, ordered, shipped: shippedByLine.get(l.id) || 0, leftover };
    })
    .filter((r) => r.leftover > 0)
    .sort((a, b) => String(orderById.get(a.l.order_id)?.order_no || '').localeCompare(String(orderById.get(b.l.order_id)?.order_no || '')));

  for (const r of sorted) {
    const o = orderById.get(r.l.order_id) || ({} as any);
    totalLeftover += r.leftover;
    ws.addRow([
      o.order_no || '', o.internal_order_no || '', o.customer_name || '', o.factory_name || '未指定',
      r.l.style_no || '', r.l.product_name || '', colorOf(r.l), r.ordered, r.shipped, r.leftover,
    ]);
  }
  if (sorted.length === 0) return { error: '当前没有剩余货物(都已出完或未录逐款出货分配)' };

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  return { base64, fileName: `剩余货物清单_${sorted.length}项_共${totalLeftover}件.xlsx` };
}
