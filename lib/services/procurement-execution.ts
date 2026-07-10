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
  color?: string | null;
  unit?: string | null;
  purchase_unit?: string | null;
  total_required_qty?: number | null;
  suggested_purchase_qty?: number | null;
  final_purchase_qty?: number | null;
  stock_deduct_qty?: number | null;      // 库存抵扣量(独立;不采购,发货领用核销)
  order_by_date?: string | null;         // 最晚下单日(到货倒推;执行行 required_by 用)
  required_date?: string | null;         // 需到日
  confirmed_supplier_name?: string | null;
  unit_price?: number | null;
  status?: string | null;
}

/** 出单量(向供应商采购的量)= 定案采购量 − 库存抵扣量。final 只承载"人工定案量",抵扣独立。 */
export function orderableQty(item: Pick<ProcItem, 'final_purchase_qty' | 'suggested_purchase_qty' | 'stock_deduct_qty'>): number {
  const gross = Number(item.final_purchase_qty ?? item.suggested_purchase_qty ?? 0) || 0;
  return Math.max(0, round3(gross - (Number(item.stock_deduct_qty) || 0)));
}

/** 执行行插入行(action 再补 ordered_at / created_at 由 DB 默认)。ordered_qty NOT NULL,兜底 0。 */
/**
 * 按订单各码件数把总量分摊到各尺码(N1)。保 Σ=total:各码四舍五入,余数(含小数)补给件数最大的码。
 * 无尺码件数 → 返回单行(size=null,整量),即老口径。总量为 kg 时小数余数落在最大码那行。
 */
export function distributeBySize(total: number, sizeCounts: Record<string, number>): Array<{ size: string | null; qty: number }> {
  const entries = Object.entries(sizeCounts || {}).filter(([, c]) => Number(c) > 0);
  const sum = entries.reduce((a, [, c]) => a + Number(c), 0);
  if (!(total > 0) || entries.length === 0 || sum <= 0) return [{ size: null, qty: total }];
  const out = entries.map(([size, c]) => ({ size, qty: Math.round((total * Number(c)) / sum) }));
  const allocated = out.reduce((a, o) => a + o.qty, 0);
  const diff = total - allocated;                          // 可为小数(kg)
  if (diff !== 0) {
    let maxI = 0;
    for (let i = 1; i < entries.length; i++) if (Number(entries[i][1]) > Number(entries[maxI][1])) maxI = i;
    out[maxI].qty = Math.round((out[maxI].qty + diff) * 100) / 100;
  }
  return out;
}

/**
 * 按权重把总量分摊到多个单元格(款×色×码 明细拆分用;distributeBySize 的泛化)。
 * 保 Σ=total:各格四舍五入,余数(含小数)补给权重最大的格。无正权重 → 空数组。
 * weights: [{key, weight}];返回 [{key, qty}],顺序与入参一致。
 */
export function distributeByWeights<K extends string | number>(
  total: number,
  weights: Array<{ key: K; weight: number }>,
): Array<{ key: K; qty: number }> {
  const entries = weights.filter((w) => Number(w.weight) > 0);
  const sum = entries.reduce((a, w) => a + Number(w.weight), 0);
  if (!(total > 0) || entries.length === 0 || sum <= 0) return [];
  const out = entries.map((w) => ({ key: w.key, qty: Math.round((total * Number(w.weight)) / sum) }));
  const allocated = out.reduce((a, o) => a + o.qty, 0);
  const diff = total - allocated;                          // 可为小数
  if (diff !== 0) {
    let maxI = 0;
    for (let i = 1; i < entries.length; i++) if (Number(entries[i].weight) > Number(entries[maxI].weight)) maxI = i;
    out[maxI].qty = Math.round((out[maxI].qty + diff) * 100) / 100;
  }
  return out;
}

// 按尺码拆分只对"按件计数"的物料成立(如尺码唛、每件一个的辅料)。
// 面料/布料等散装按重量/长度采购的物料:整卷开裁,采购量不该按各码件数均分
// (且大码比小码更费料,按件数比例分摊本身也失真)。→ 这类物料不拆码,单行整量。
const BULK_MATERIAL_CATEGORIES = new Set(['面料', '布料', '主料', 'fabric', 'main_fabric']);
const BULK_MATERIAL_UNITS = new Set([
  'kg', '千克', '公斤', 'g', '克', 't', '吨',
  '米', 'm', '码', 'yd', 'yard', '尺', 'cm', '厘米', 'mm', '毫米',
  '卷', '匹',
]);

/** 该采购项是否应按尺码拆分:面料/散装(按重量·长度计)→ 否(单行整量);按件计数 → 是。 */
export function shouldSplitBySize(item: Pick<ProcItem, 'category' | 'unit' | 'purchase_unit'>): boolean {
  const cat = String(item.category ?? '').trim().toLowerCase();
  if (BULK_MATERIAL_CATEGORIES.has(cat)) return false;
  // 采购单位或基础单位任一为散装计量(kg/米…)→ 不拆码。
  // 注:此前用 `purchase_unit ?? unit`,当 purchase_unit 为空串 '' 时(?? 不兜底 '')会取到 ''、
  // 漏判散装 → 布料被按尺码拆成多行(每行还是整量)。改为分别判 purchase_unit 与 unit,任一散装即不拆。
  const pu = String(item.purchase_unit || '').trim().toLowerCase();
  const bu = String(item.unit || '').trim().toLowerCase();
  if (BULK_MATERIAL_UNITS.has(pu) || BULK_MATERIAL_UNITS.has(bu)) return false;
  return true;
}

/** 布料/散装物料判定(按类别或单位)——用于「待归单/下单」把历史按尺码拆的布料行合并回一行。 */
export function isBulkMaterial(category?: string | null, unit?: string | null): boolean {
  const cat = String(category ?? '').trim().toLowerCase();
  if (BULK_MATERIAL_CATEGORIES.has(cat)) return true;
  const u = String(unit ?? '').trim().toLowerCase();
  return BULK_MATERIAL_UNITS.has(u);
}

/**
 * 布料被历史(旧 generateExecutionLines / 手工)按尺码拆成多行时,还原真实总量:
 * - 各行数量相等 → 「整量复制」老 bug(每码都记了整量)→ 取其中一行的值;
 * - 各行数量不等 → 按各码分摊 → 求和还原总量。
 * 两种都能还原正确总量(布料本就不该分尺码)。
 */
export function reconcileBulkQty(qtys: Array<number | null | undefined>): number {
  const arr = qtys.map((q) => Number(q) || 0);
  if (arr.length <= 1) return arr[0] || 0;
  const allEqual = arr.every((q) => Math.abs(q - arr[0]) < 1e-6);
  return allEqual ? arr[0] : Math.round(arr.reduce((a, b) => a + b, 0) * 1000) / 1000;
}

export function buildExecutionLineRow(item: ProcItem, userId: string, opts?: { size?: string | null; qtyOverride?: number }): Record<string, any> {
  return {
    order_id: item.order_id,
    procurement_item_id: item.id,
    material_name: item.material_name || item.consolidation_key || '未命名物料',
    specification: item.specification ?? null,
    category: item.category ?? null,
    supplier_name: item.confirmed_supplier_name ?? null,
    size: opts?.size ?? null,                              // 尺码(N1;拆码行填,整行为 null)
    ordered_qty: opts?.qtyOverride ?? orderableQty(item),  // 定案量 − 库存抵扣;拆码时用分摊量
    ordered_unit: item.purchase_unit || item.unit || null,
    unit_price: item.unit_price ?? null, // 大货底价,业务读时剥离
    // required_by = 需到日(货到厂日,采购可手选);computeLineLamp 内部再减交期算最晚下单。
    // (原用 order_by_date=需到日−交期 → 灯里再减一次=双减,且缺料风险"需X前到"显示的是下单日而非到货日)
    required_by: item.required_date ?? item.order_by_date ?? null,
    ordered_by: userId,
    // R3(2026-07-02 审计):DB 默认 'draft' 不在采购中心任何队列;显式置待下单
    line_status: 'pending_order',
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
  color: string | null;
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
      color: it.color ?? null,
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
