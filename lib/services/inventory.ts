/**
 * 库存 — 纯逻辑（W0）
 * append-only 流水 → 派生余额。material_key 复用 consolidationKey。
 */

import { consolidationKey } from './procurement-consolidation';

export interface InvTxn {
  material_key: string;
  material_name?: string | null;
  unit?: string | null;
  qty: number; // 带符号:receipt/return/+adjust 为+;issue/scrap 为−
}

export interface InvBalance {
  material_key: string;
  material_name: string | null;
  unit: string | null;
  on_hand: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 派生余额:按 material_key Σ qty。 */
export function aggregateInventoryBalance(txns: InvTxn[]): InvBalance[] {
  const m = new Map<string, InvBalance>();
  for (const t of txns) {
    let b = m.get(t.material_key);
    if (!b) {
      b = { material_key: t.material_key, material_name: t.material_name ?? null, unit: t.unit ?? null, on_hand: 0 };
      m.set(t.material_key, b);
    }
    b.on_hand += Number(t.qty) || 0;
    if (!b.material_name && t.material_name) b.material_name = t.material_name;
    if (!b.unit && t.unit) b.unit = t.unit;
  }
  const out = [...m.values()];
  for (const b of out) b.on_hand = round3(b.on_hand);
  return out.sort((a, b) => (a.material_name || '').localeCompare(b.material_name || ''));
}

/** 增量入库量 = 当前实收 − 已入库(该行 receipt 流水 Σ)。 */
export function computeReceiptDelta(currentReceived: number, priorReceiptSum: number): number {
  return round3((Number(currentReceived) || 0) - (Number(priorReceiptSum) || 0));
}

export interface LeftoverRow {
  material_key: string;
  material_name: string | null;
  unit: string | null;
  received: number; // Σ receipt
  consumed: number; // Σ issue − Σ return（+ scrap）
  leftover: number; // received − consumed
}

/**
 * 真尾货（按订单，逐物料）= received − consumed。
 * received=Σ receipt;consumed=Σ(issue/scrap 取正)−Σ return。adjust(盘点)不计入订单尾货。
 * ⚠️ 值取决于领料是否真被录;不录则 consumed=0、尾货=received。
 */
export type LeftoverTxn = InvTxn & { txn_type: string };
export function computeOrderLeftover(txns: LeftoverTxn[]): LeftoverRow[] {
  const m = new Map<string, LeftoverRow>();
  for (const t of txns) {
    let r = m.get(t.material_key);
    if (!r) {
      r = { material_key: t.material_key, material_name: t.material_name ?? null, unit: t.unit ?? null, received: 0, consumed: 0, leftover: 0 };
      m.set(t.material_key, r);
    }
    if (!r.material_name && t.material_name) r.material_name = t.material_name;
    if (!r.unit && t.unit) r.unit = t.unit;
    const q = Number(t.qty) || 0;
    if (t.txn_type === 'receipt') r.received += q; // +
    else if (t.txn_type === 'issue' || t.txn_type === 'return' || t.txn_type === 'scrap') r.consumed += -q; // issue/scrap 存−→消耗+;return 存+→消耗−
    // adjust(盘点)不计入订单尾货
  }
  const out = [...m.values()];
  for (const r of out) {
    r.received = round3(r.received);
    r.consumed = round3(r.consumed);
    r.leftover = round3(r.received - r.consumed);
  }
  return out.filter((r) => r.received !== 0 || r.consumed !== 0).sort((a, b) => (a.material_name || '').localeCompare(b.material_name || ''));
}

/** 采购行 → material_key（与 P3 netting 同口径）。 */
export function materialKeyForLine(line: {
  material_name?: string | null; specification?: string | null; category?: string | null; ordered_unit?: string | null;
}): string {
  return consolidationKey({
    material_name: line.material_name, specification: line.specification, category: line.category, unit: line.ordered_unit,
  });
}
