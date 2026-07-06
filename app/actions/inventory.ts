'use server';

/**
 * 库存（W0）—— append-only 流水 + 派生余额。
 * recordInventoryReceipt: 采购收货 → 自动入库(增量 delta,幂等)。
 * 领料/退料/盘点(issue/return/adjust) = W1。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { aggregateInventoryBalance, computeReceiptDelta, computeOrderLeftover, materialKeyForLine, availableToPromise, computeAvailability, type ReservationRow } from '@/lib/services/inventory';

async function authIssueRoles() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, roles: [] as string[] };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, roles };
}

/** 采购行收货 → 自动入库(增量)。多次收货/更正只补差额。append-only。 */
export async function recordInventoryReceipt(lineId: string): Promise<{ ok?: boolean; delta?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: line } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, material_name, specification, category, ordered_unit, received_qty, procurement_item_id')
    .eq('id', lineId).maybeSingle();
  if (!line) return { error: '采购行不存在' };

  const received = Number((line as any).received_qty) || 0;

  // 已入库(该行 receipt 流水 Σ)
  const { data: prior } = await (supabase.from('inventory_transactions') as any)
    .select('qty').eq('source_ref', lineId).eq('txn_type', 'receipt');
  const priorSum = ((prior || []) as any[]).reduce((s, t) => s + (Number(t.qty) || 0), 0);

  const delta = computeReceiptDelta(received, priorSum);
  if (delta === 0) return { ok: true, delta: 0 };

  // P0:优先用采购项规范 consolidation_key(含 color+master),使库存 key 与采购项/内核同口径;
  // 无 procurement_item_id 的老手工行 → 回退 materialKeyForLine(不含色,legacy)。
  let materialKey = materialKeyForLine(line as any);
  if ((line as any).procurement_item_id) {
    const { data: pitem } = await (supabase.from('procurement_items') as any)
      .select('consolidation_key').eq('id', (line as any).procurement_item_id).maybeSingle();
    if ((pitem as any)?.consolidation_key) materialKey = (pitem as any).consolidation_key;
  }

  const row: Record<string, any> = {
    material_key: materialKey,
    material_name: (line as any).material_name,
    unit: (line as any).ordered_unit,
    txn_type: 'receipt',
    qty: delta,
    order_id: (line as any).order_id,
    source_ref: lineId,
    created_by: user.id,
    note: '采购收货自动入库',
    receipt_cumulative_qty: received, // 幂等目标:该行累计收货到 received
  };
  // 复审:幂等 upsert —— 并发双击算出同 cumulative → 唯一冲突 DO NOTHING,不重复入库
  let { error } = await (supabase.from('inventory_transactions') as any)
    .upsert(row, { onConflict: 'source_ref,txn_type,receipt_cumulative_qty', ignoreDuplicates: true });
  if (error && /receipt_cumulative_qty|does not exist|column|on conflict|constraint/i.test(error.message || '')) {
    // 迁移(20260705_inventory_receipt_idempotency)未执行 → 降级普通 insert(老行为,无并发幂等)
    const { receipt_cumulative_qty, ...plain } = row;
    ({ error } = await (supabase.from('inventory_transactions') as any).insert(plain));
  }
  if (error) return { error: error.message };
  return { ok: true, delta };
}

/** 派生库存余额(按物料 Σ 流水)。 */
export async function getInventoryBalance(): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: txns, error } = await (supabase.from('inventory_transactions') as any)
    .select('material_key, material_name, unit, qty');
  if (error) return { error: error.message };
  const balance = aggregateInventoryBalance((txns || []) as any[]) as any[];
  // 补颜色(2026-07-06 用户反馈:同料不同色如 280g直贡呢 黑色/浓咖啡 在库存显示成两行一样的)。
  // 走 service-role + 收货流水来源(source_ref=采购执行行)→ 行的 procurement_item_id → procurement_items.color,
  // 与采购队列取色同一可靠路径;再用 consolidation_key 兜底(无 source_ref 的老流水)。
  try {
    const keys = [...new Set(balance.map((b) => b.material_key).filter(Boolean))] as string[];
    if (keys.length) {
      const svc = createServiceRoleClient();
      // material_key → 任一有来源的收货行 id(同 key 同色,取一条即可)
      const { data: srcTxns } = await (svc.from('inventory_transactions') as any)
        .select('material_key, source_ref').in('material_key', keys).not('source_ref', 'is', null);
      const lineByKey = new Map<string, string>();
      for (const t of (srcTxns || [])) { if (t.source_ref && !lineByKey.has(t.material_key)) lineByKey.set(t.material_key, t.source_ref); }
      // 行 → procurement_item_id
      const lineIds = [...new Set(lineByKey.values())];
      const piByLine = new Map<string, string>();
      if (lineIds.length) {
        const { data: lines } = await (svc.from('procurement_line_items') as any)
          .select('id, procurement_item_id').in('id', lineIds);
        for (const l of (lines || [])) { if (l.procurement_item_id) piByLine.set(l.id, l.procurement_item_id); }
      }
      // procurement_item → color
      const piIds = [...new Set(piByLine.values())];
      const colorByPi = new Map<string, string | null>();
      if (piIds.length) {
        const { data: pis } = await (svc.from('procurement_items') as any).select('id, color').in('id', piIds);
        for (const p of (pis || [])) colorByPi.set(p.id, p.color ?? null);
      }
      // 兜底:consolidation_key = material_key
      const { data: pisByKey } = await (svc.from('procurement_items') as any)
        .select('consolidation_key, color').in('consolidation_key', keys);
      const colorByKey = new Map<string, string | null>();
      for (const p of (pisByKey || [])) { const k = p.consolidation_key; if (k && !colorByKey.has(k)) colorByKey.set(k, p.color ?? null); }

      for (const b of balance) {
        const lineId = lineByKey.get(b.material_key);
        const pi = lineId ? piByLine.get(lineId) : undefined;
        (b as any).color = (pi ? colorByPi.get(pi) : null) ?? colorByKey.get(b.material_key) ?? null;
      }
    }
  } catch (e: any) { console.warn('[getInventoryBalance] 颜色补充失败(不影响库存展示):', e?.message); }
  return { data: balance };
}

export interface IssueInput {
  materialKey: string;
  materialName?: string | null;
  unit?: string | null;
  orderId?: string | null;
  qty: number; // 正数(领料量/退料量);issue 存负,return 存正
  note?: string;
}

/** 领料(issue,−)/退料(return,+)。CAN_ISSUE_MATERIAL 门控。v1 允许负库存。 */
async function writeInvOut(txnType: 'issue' | 'return', input: IssueInput): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无领料/退料权限' };
  const q = Number(input.qty);
  if (!(q > 0)) return { error: '数量必须大于 0' };
  if (!input.materialKey) return { error: '物料必填' };

  const { error } = await (supabase.from('inventory_transactions') as any).insert({
    material_key: input.materialKey,
    material_name: input.materialName ?? null,
    unit: input.unit ?? null,
    txn_type: txnType,
    qty: txnType === 'issue' ? -q : q, // 领料 −;退料 +
    order_id: input.orderId || null,
    created_by: userId,
    note: input.note || null,
  });
  if (error) return { error: error.message };
  // 领料兑现库存抵扣预留(2026-07-04 审计修:consumeReservation 原零调用 → 预留永久锁死、消耗蒸发)。
  // 该订单该物料若有 reserved 预留(来自采购 deductFromStock),领料即兑现 → 转 consumed,释放可用量占用。
  if (txnType === 'issue' && input.orderId) {
    try {
      const { data: rvs } = await (supabase.from('inventory_reservation') as any)
        .select('id').eq('order_id', input.orderId).eq('material_key', input.materialKey).eq('status', 'reserved');
      for (const r of (rvs || [])) {
        await (supabase.from('inventory_reservation') as any)
          .update({ status: 'consumed', consumed_at: new Date().toISOString() }).eq('id', (r as any).id).eq('status', 'reserved');
      }
    } catch { /* 预留兑现失败不阻断领料 */ }
  }
  revalidatePath('/procurement/inventory');
  return { ok: true };
}

export async function recordInventoryIssue(input: IssueInput) { return writeInvOut('issue', input); }
export async function recordInventoryReturn(input: IssueInput) { return writeInvOut('return', input); }

// ════════════════════════════════════════════════════════════════════════
// 尾料清点归库(出货后)—— 采购清点每物料实际尾料,系统把该订单账面盘到清点数。
// 账面高于清点 → 写 issue 核减(视作已消耗);账面低于清点 → 写 adjust 盘盈。
// 余料留在共享库存池(material_key),下次采购同料自动抵扣。带库位。append-only。
// ════════════════════════════════════════════════════════════════════════
export interface StocktakeItem {
  materialKey: string;
  materialName?: string | null;
  unit?: string | null;
  countedQty: number;   // 清点实际尾料(≥0)
  location?: string | null;  // 仓库库位
}

export async function recordLeftoverStocktake(
  orderId: string, items: StocktakeItem[],
): Promise<{ ok?: boolean; adjusted?: number; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无归库权限(需仓库/采购/管理员)' };
  if (!orderId) return { error: '订单必填' };
  const valid = (items || []).filter(i => i?.materialKey && i.countedQty != null && Number(i.countedQty) >= 0);
  if (valid.length === 0) return { error: '没有可归库的物料' };

  // 该订单每 material_key 的当前账面(receipt−issue+return±adjust)
  const keys = [...new Set(valid.map(i => i.materialKey))];
  const { data: txns } = await (supabase.from('inventory_transactions') as any)
    .select('material_key, qty').eq('order_id', orderId).in('material_key', keys);
  const onHandByKey = new Map<string, number>();
  for (const t of (txns || []) as any[]) onHandByKey.set(t.material_key, (onHandByKey.get(t.material_key) || 0) + (Number(t.qty) || 0));

  const rows: any[] = [];
  for (const it of valid) {
    const current = onHandByKey.get(it.materialKey) || 0;
    const counted = Number(it.countedQty);
    const delta = Math.round((counted - current) * 1000) / 1000;
    if (delta === 0) continue;
    rows.push({
      material_key: it.materialKey,
      material_name: it.materialName ?? null,
      unit: it.unit ?? null,
      // 账面高于清点 → 差额视作消耗(issue,−);账面低于清点 → 盘盈(adjust,+)
      txn_type: delta < 0 ? 'issue' : 'adjust',
      qty: delta,   // 已带符号
      order_id: orderId,
      location: it.location?.trim() || null,
      created_by: userId,
      note: `出货后尾料清点归库(账面 ${current} → 实际 ${counted})`,
    });
  }
  if (rows.length === 0) return { ok: true, adjusted: 0 };

  const { error } = await (supabase.from('inventory_transactions') as any).insert(rows);
  if (error) return { error: error.message };
  revalidatePath('/procurement/inventory');
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, adjusted: rows.length };
}

/** 批量取一组 material_key 的可用库存(onHand−reserved)+ 最近库位。供采购抵扣/展示。 */
export async function getAvailableStockByKeys(
  keys: string[],
): Promise<{ data?: Record<string, { onHand: number; reserved: number; available: number; location: string | null }>; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const uniq = [...new Set((keys || []).filter(Boolean))];
  if (uniq.length === 0) return { data: {} };

  const { data: txns } = await (supabase.from('inventory_transactions') as any)
    .select('material_key, qty, location, created_at').in('material_key', uniq).order('created_at', { ascending: false });
  const { data: resv } = await (supabase.from('inventory_reservation') as any)
    .select('material_key, qty').in('material_key', uniq).eq('status', 'reserved');

  const onHand = new Map<string, number>();
  const loc = new Map<string, string | null>();
  for (const t of (txns || []) as any[]) {
    onHand.set(t.material_key, (onHand.get(t.material_key) || 0) + (Number(t.qty) || 0));
    if (!loc.has(t.material_key) && t.location) loc.set(t.material_key, t.location); // 最近一条有库位的
  }
  const reserved = new Map<string, number>();
  for (const r of (resv || []) as any[]) reserved.set(r.material_key, (reserved.get(r.material_key) || 0) + (Number(r.qty) || 0));

  const out: Record<string, any> = {};
  for (const k of uniq) {
    const oh = Math.round((onHand.get(k) || 0) * 1000) / 1000;
    const rv = Math.round((reserved.get(k) || 0) * 1000) / 1000;
    out[k] = { onHand: oh, reserved: rv, available: Math.max(0, Math.round((oh - rv) * 1000) / 1000), location: loc.get(k) || null };
  }
  return { data: out };
}

/** 库存流水(审计,可按物料筛)。 */
export async function getInventoryTransactions(materialKey?: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  let q = (supabase.from('inventory_transactions') as any)
    .select('id, material_key, material_name, unit, txn_type, qty, order_id, note, created_at')
    .order('created_at', { ascending: false }).limit(200);
  if (materialKey) q = q.eq('material_key', materialKey);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { data: data || [] };
}

/** 真尾货(按订单,逐物料)= received − consumed。派生,单一来源 inventory_transactions。 */
export async function getOrderLeftover(orderId: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: txns, error } = await (supabase.from('inventory_transactions') as any)
    .select('material_key, material_name, unit, txn_type, qty').eq('order_id', orderId);
  if (error) return { error: error.message };
  const rows = computeOrderLeftover((txns || []) as any[]) as any[];
  // 颜色:material_key = 采购项 consolidation_key(含色)→ 回查 color,让真尾货分色显示(2026-07-06 用户反馈)
  try {
    const keys = [...new Set(rows.map((r) => r.material_key).filter(Boolean))] as string[];
    if (keys.length) {
      const { data: pis } = await (createServiceRoleClient().from('procurement_items') as any)
        .select('consolidation_key, color').in('consolidation_key', keys);
      const cbk = new Map<string, string | null>();
      for (const p of (pis || [])) { const k = (p as any).consolidation_key; if (k && !cbk.has(k)) cbk.set(k, (p as any).color ?? null); }
      for (const r of rows) r.color = r.material_key ? (cbk.get(r.material_key) ?? null) : null;
    }
  } catch (e: any) { console.warn('[getOrderLeftover] 颜色补充失败(不影响尾货):', e?.message); }
  return { data: rows };
}

/** 领料可挂的订单列表(CAN_ISSUE_MATERIAL)。 */
export async function listOrdersForIssue(limit = 100): Promise<{ data?: any[]; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无权' };
  const { data, error } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name')
    .neq('lifecycle_status', 'cancelled').order('created_at', { ascending: false }).limit(limit);
  if (error) return { error: error.message };
  return { data: data || [] };
}

// ════════════════════════════════════════════════════════════════════════
// SC-P2 库存真相层:仓库 + 预留 + 可用量。唯一可用量出口 = availableToPromise/computeAvailability。
// 读=登录即可;预留写=CAN_ISSUE_MATERIAL。不改 append-only 账本逻辑。
// ════════════════════════════════════════════════════════════════════════

/** 仓库列表(激活的)。 */
export async function listWarehouses(): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('warehouse') as any)
    .select('id, code, name, type, is_default, status').eq('status', 'active').order('is_default', { ascending: false }).order('name');
  if (error) return { error: error.message };
  return { data: data || [] };
}

/** 可用量看板:逐物料 onHand/reserved/available/safety/shortage(唯一算法)。可按仓库过滤。 */
export async function getInventoryAvailability(warehouseId?: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  let tq = (supabase.from('inventory_transactions') as any).select('material_key, material_name, unit, qty, warehouse_id');
  if (warehouseId) tq = tq.eq('warehouse_id', warehouseId);
  const { data: txns, error } = await tq;
  if (error) return { error: error.message };
  const balance = aggregateInventoryBalance((txns || []) as any[]);

  let rq = (supabase.from('inventory_reservation') as any).select('material_key, qty, status').eq('status', 'reserved');
  if (warehouseId) rq = rq.eq('warehouse_id', warehouseId);
  const { data: resv } = await rq;
  // 安全库存:聚合视图暂不接 material_master(material_key≠master_id,映射不干;单物料查询才精确)。
  return { data: computeAvailability(balance, (resv || []) as ReservationRow[], undefined) };
}

/** 单物料可用量(材料主数据时接精确 safety)。全系统唯一算法。 */
export async function getAvailableStock(
  materialKey: string, warehouseId?: string, materialMasterId?: string,
): Promise<{ data?: { onHand: number; reserved: number; safety: number; available: number }; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  let tq = (supabase.from('inventory_transactions') as any).select('qty').eq('material_key', materialKey);
  if (warehouseId) tq = tq.eq('warehouse_id', warehouseId);
  const { data: txns } = await tq;
  const onHand = ((txns || []) as any[]).reduce((s, t) => s + (Number(t.qty) || 0), 0);

  let rq = (supabase.from('inventory_reservation') as any).select('qty').eq('material_key', materialKey).eq('status', 'reserved');
  if (warehouseId) rq = rq.eq('warehouse_id', warehouseId);
  const { data: resv } = await rq;
  const reserved = ((resv || []) as any[]).reduce((s, r) => s + (Number(r.qty) || 0), 0);

  let safety = 0;
  if (materialMasterId) {
    const { data: mm } = await (supabase.from('material_master') as any).select('safety_stock_qty').eq('id', materialMasterId).maybeSingle();
    safety = Number((mm as any)?.safety_stock_qty) || 0;
  }
  return { data: { onHand: Math.round(onHand * 1000) / 1000, reserved: Math.round(reserved * 1000) / 1000, safety, available: availableToPromise({ onHand, reserved, safety }) } };
}

/** 某订单的预留明细。 */
export async function getReservationByOrder(orderId: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('inventory_reservation') as any)
    .select('id, material_key, material_master_id, qty, status, warehouse_id, source, created_at, released_at, consumed_at')
    .eq('order_id', orderId).order('created_at', { ascending: false });
  if (error) return { error: error.message };
  return { data: data || [] };
}

export interface ReserveInput {
  materialKey: string; materialMasterId?: string | null; orderId?: string | null;
  procurementItemId?: string | null; warehouseId?: string | null; qty: number; source?: string; note?: string;
}

/** 建预留(逻辑锁)。status=reserved。CAN_ISSUE_MATERIAL。不动账本,只占用可用量。 */
export async function reserveStock(input: ReserveInput): Promise<{ ok?: boolean; id?: string; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无预留权限' };
  const qty = Number(input.qty);
  if (!input.materialKey) return { error: '缺 material_key' };
  if (!(qty > 0)) return { error: '预留数量必须 > 0' };
  const source = ['order', 'procurement', 'manual'].includes(input.source || '') ? input.source : 'manual';
  const { data, error } = await (supabase.from('inventory_reservation') as any).insert({
    material_key: input.materialKey, material_master_id: input.materialMasterId || null,
    order_id: input.orderId || null, procurement_item_id: input.procurementItemId || null,
    warehouse_id: input.warehouseId || null, qty, status: 'reserved', source,
    note: input.note || null, created_by: userId,
  }).select('id').single();
  if (error) return { error: error.message };
  revalidatePath('/procurement/inventory');
  return { ok: true, id: (data as any)?.id };
}

/** 释放预留(取消)→ status=released,放回可用池。按 id 或整单。CAN_ISSUE_MATERIAL。 */
export async function releaseReservation(input: { id?: string; orderId?: string }): Promise<{ ok?: boolean; released?: number; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无权' };
  if (!input.id && !input.orderId) return { error: '需 id 或 orderId' };
  let q = (supabase.from('inventory_reservation') as any)
    .update({ status: 'released', released_at: new Date().toISOString() }).eq('status', 'reserved');
  q = input.id ? q.eq('id', input.id) : q.eq('order_id', input.orderId);
  const { data, error } = await q.select('id');
  if (error) return { error: error.message };
  revalidatePath('/procurement/inventory');
  return { ok: true, released: (data || []).length };
}

/** 消耗预留(领料出库时)→ status=consumed。实际出库流水由领料流程写(SC-P4)。CAN_ISSUE_MATERIAL。 */
export async function consumeReservation(reservationId: string): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无权' };
  const { error } = await (supabase.from('inventory_reservation') as any)
    .update({ status: 'consumed', consumed_at: new Date().toISOString() })
    .eq('id', reservationId).eq('status', 'reserved');
  if (error) return { error: error.message };
  revalidatePath('/procurement/inventory');
  return { ok: true };
}
