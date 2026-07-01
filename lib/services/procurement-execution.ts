/**
 * 采购执行链 — 纯逻辑(B3a)
 * ADR-004 第3层(procurement_items 采购确认)→ 第4层(procurement_line_items 采购执行)。
 * 桥:确认的采购项 → 执行行(挂 procurement_item_id)。
 * 核销:按 consolidation_key 派生 需求/下单/收货/消耗/尾货。
 * 状态联动:收货量推进 item 生命周期(只进不退,不碰人工阶段 draft/reviewing/closed)。
 */

const round3 = (n: number) => Math.round(((Number(n) || 0)) * 1000) / 1000;

export interface ProcItem {
  id: string;
  order_id: string;
  consolidation_key: string;
  material_name?: string | null;
  specification?: string | null;
  category?: string | null;
  unit?: string | null;
  purchase_unit?: string | null;
  total_required_qty?: number | null;
  suggested_purchase_qty?: number | null;
  final_purchase_qty?: number | null;
  confirmed_supplier_name?: string | null;
  unit_price?: number | null;
  status?: string | null;
}

/** 执行行插入行(action 再补 ordered_at / created_at 由 DB 默认)。ordered_qty NOT NULL,兜底 0。 */
export function buildExecutionLineRow(item: ProcItem, userId: string): Record<string, any> {
  const qty = item.final_purchase_qty ?? item.suggested_purchase_qty ?? 0;
  return {
    order_id: item.order_id,
    procurement_item_id: item.id,
    material_name: item.material_name || item.consolidation_key || '未命名物料',
    specification: item.specification ?? null,
    category: item.category ?? null,
    supplier_name: item.confirmed_supplier_name ?? null,
    ordered_qty: round3(qty),
    ordered_unit: item.purchase_unit || item.unit || null,
    unit_price: item.unit_price ?? null, // 大货底价,业务读时剥离
    ordered_by: userId,
  };
}

/** 采购项能否生成执行行:必须已确认(confirmed)。draft/reviewing 未定案,ordered+ 已生成过。 */
export function canGenerateExecution(item: ProcItem): boolean {
  return item.status === 'confirmed';
}

const STATUS_RANK: Record<string, number> = {
  draft: 0, reviewing: 1, confirmed: 2, ordered: 3, partially_received: 4, completed: 5, closed: 6,
};

/**
 * 收货量推进 item 状态(只进不退)。
 * received≥ordered>0 → completed;received>0 → partially_received;否则不变。
 * 只对已到 confirmed(rank≥2)且未 closed 的自动推进;draft/reviewing/closed 不碰。
 */
export function resolveReceivingStatus(current: string | null | undefined, receivedTotal: number, orderedTotal: number): string {
  const cur = current || 'draft';
  const curRank = STATUS_RANK[cur] ?? 0;
  if (cur === 'closed' || curRank < 2) return cur; // 未确认 / 已关 → 不自动动
  const recv = Number(receivedTotal) || 0;
  const ord = Number(orderedTotal) || 0;
  let target: string;
  if (ord > 0 && recv >= ord) target = 'completed';
  else if (recv > 0) target = 'partially_received';
  else return cur; // 无收货 → 保持(下单推进走 place 钩子)
  const tgt = STATUS_RANK[target] ?? curRank;
  return tgt > curRank ? target : cur;
}

/** 下单(PO placed)推进:confirmed → ordered(只进不退,不碰更高/更低)。 */
export function resolveOrderedStatus(current: string | null | undefined): string {
  const cur = current || 'draft';
  return cur === 'confirmed' ? 'ordered' : cur;
}

export interface FulfillmentRow {
  procurement_item_id: string;
  consolidation_key: string;
  material_name: string | null;
  unit: string | null;
  status: string | null;
  required: number;   // 系统需求(total_required_qty)
  ordered: number;    // Σ 执行行 ordered_qty
  received: number;   // Σ 执行行 received_qty
  consumed: number;   // 领料消耗(库存流水,按 consolidation_key)
  leftover: number;   // received − consumed(真尾货)
}

/**
 * 核销派生(单一来源:items + 执行行 + 库存尾货行)。
 * lines: {procurement_item_id, ordered_qty, received_qty}[];leftoverRows: {material_key, received, consumed}[]。
 */
export function deriveFulfillment(
  items: ProcItem[],
  lines: { procurement_item_id?: string | null; ordered_qty?: number | null; received_qty?: number | null }[],
  leftoverRows: { material_key: string; received?: number | null; consumed?: number | null }[],
): FulfillmentRow[] {
  const lineByItem = new Map<string, { ordered: number; received: number }>();
  for (const l of lines) {
    if (!l.procurement_item_id) continue;
    const acc = lineByItem.get(l.procurement_item_id) || { ordered: 0, received: 0 };
    acc.ordered += Number(l.ordered_qty) || 0;
    acc.received += Number(l.received_qty) || 0;
    lineByItem.set(l.procurement_item_id, acc);
  }
  const leftByKey = new Map<string, { received: number; consumed: number }>();
  for (const r of leftoverRows) leftByKey.set(r.material_key, { received: Number(r.received) || 0, consumed: Number(r.consumed) || 0 });

  return items.map((it) => {
    const ln = lineByItem.get(it.id) || { ordered: 0, received: 0 };
    const lo = leftByKey.get(it.consolidation_key) || { received: ln.received, consumed: 0 };
    const received = round3(ln.received || lo.received);
    const consumed = round3(lo.consumed);
    return {
      procurement_item_id: it.id,
      consolidation_key: it.consolidation_key,
      material_name: it.material_name ?? null,
      unit: it.unit ?? null,
      status: it.status ?? null,
      required: round3(Number(it.total_required_qty) || 0),
      ordered: round3(ln.ordered),
      received,
      consumed,
      leftover: round3(received - consumed),
    };
  });
}
