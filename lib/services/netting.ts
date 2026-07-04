/**
 * 跨订单 netting — 纯聚合（P3 A）
 *
 * 把未归单的待下单采购行，跨订单按 consolidation_key（物料身份+颜色+单位）聚合。
 * 纯派生（不存）；建单复用 P1 createPurchaseOrder。行的 order_id 不变 → peg 天然。
 */

import { consolidationKey } from './procurement-consolidation';

export interface NettingLine {
  id: string;
  order_id: string;
  order_no?: string | null;
  internal_order_no?: string | null;
  material_master_id?: string | null;  // 审计 P0:归并键须与库存/采购项同口径(master 优先)
  material_name: string;
  specification?: string | null;
  category?: string | null;
  color?: string | null;
  ordered_qty?: number | null;
  ordered_unit?: string | null;
}

export interface NettingContributor {
  order_id: string;
  order_ref: string; // internal_order_no || order_no
  line_id: string;
  qty: number;
}

export interface NettingGroup {
  key: string;
  material_name: string;
  specification: string | null;
  category: string | null;
  unit: string | null;
  total_qty: number;
  order_count: number;
  line_ids: string[];
  contributors: NettingContributor[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 按 consolidation_key 聚合；跨订单组排前。 */
export function aggregateLinesByKey(lines: NettingLine[]): NettingGroup[] {
  const groups = new Map<string, NettingGroup>();

  for (const l of lines) {
    const key = consolidationKey({
      material_master_id: l.material_master_id,   // master 优先,与库存/采购项同口径
      material_name: l.material_name,
      specification: l.specification,
      category: l.category,
      color: l.color,
      unit: l.ordered_unit,
    });
    let g = groups.get(key);
    if (!g) {
      g = {
        key, material_name: l.material_name, specification: l.specification ?? null,
        category: l.category ?? null, unit: l.ordered_unit ?? null,
        total_qty: 0, order_count: 0, line_ids: [], contributors: [],
      };
      groups.set(key, g);
    }
    const qty = Number(l.ordered_qty) || 0;
    g.total_qty += qty;
    g.line_ids.push(l.id);
    g.contributors.push({
      order_id: l.order_id,
      order_ref: l.internal_order_no || l.order_no || l.order_id,
      line_id: l.id,
      qty,
    });
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.total_qty = round3(g.total_qty);
    g.order_count = new Set(g.contributors.map((c) => c.order_id)).size;
  }
  // 跨订单(order_count 大)优先，其次总量大
  return out.sort((a, b) => b.order_count - a.order_count || b.total_qty - a.total_qty);
}
