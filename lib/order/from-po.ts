/**
 * QIMO OS — PO → Order Adapter v1（继承映射，纯函数）
 *
 * 由 customer_po 绑定 + quote 冻结快照 → Order 草稿（继承字段）。
 *
 * NON-NEGOTIABLE：
 *   - 逐字继承快照，绝不重算 price/cost/margin（不 import RAG/成本引擎）。
 *   - ❌ 不 OCR 覆盖 · ❌ 不 AI override · ❌ 不写库（纯映射，供既有 createOrder 消费）。
 *   - fail-closed：快照版本 ≠ PO 绑定版本 → 抛错（订单必须绑 PO 引用的那一冻结版）。
 *
 * 注意：本适配器产出的是**继承草稿**；将 PO↔Order 绑定**持久化**到 orders 行
 * （customer_po_id / quote_snapshot_version 等列）需要一次加法 migration，
 * 不在"禁改 schema"范围内 —— 见交付说明。
 */

import type { QuoteSnapshot } from '@/lib/quoter/types';
import type { CompareBasis } from '@/lib/quoter/consumption';

export interface CustomerPoLike {
  id: string;
  po_number: string;
  customer_id: string;
  quote_id: string;
  quote_snapshot_version: number;
}

export interface OrderDraftFromPO {
  source: 'PO';
  customer_id: string;
  customer_name: string | null;
  customer_po_number: string;
  /** 血缘引用（只引用，不复制业务逻辑） */
  origin_quote_id: string;
  customer_po_id: string;
  quote_snapshot_version: number;
  approved_version: number;
  price_floor: number | null;
  currency: string | null;
  /** 逐字继承的快照行（pricing truth，绝不重算） */
  lines: unknown[];
  inherited_from: { snapshot_version: number; po_id: string };
}

/**
 * @throws Error('snapshot_version_mismatch') 当 snapshot.version ≠ po.quote_snapshot_version
 */
export function buildOrderDraftFromPO(
  po: CustomerPoLike,
  snapshot: QuoteSnapshot,
  envelope: { priceFloor: number | null } = { priceFloor: null },
): OrderDraftFromPO {
  if (snapshot.version !== po.quote_snapshot_version) {
    throw new Error('snapshot_version_mismatch');
  }
  const header = (snapshot.header ?? {}) as Record<string, unknown>;

  return {
    source: 'PO',
    customer_id: po.customer_id,
    customer_name: (header.customer_name as string) ?? null,
    customer_po_number: po.po_number,
    origin_quote_id: po.quote_id, // REFERENCE，非复制
    customer_po_id: po.id,
    quote_snapshot_version: po.quote_snapshot_version,
    approved_version: po.quote_snapshot_version, // PO 绑定的即 Approved 冻结版
    price_floor: envelope.priceFloor,
    currency: (header.currency as string) ?? null,
    lines: snapshot.lines, // 逐字继承，NEVER 重算
    inherited_from: { snapshot_version: snapshot.version, po_id: po.id },
  };
}

/**
 * 从消费闸门结果（CompareBasis）派生 Order 草稿 —— 带 **approval 硬门**。
 * snapshot 非 approved / 不可消费 / 版本不符 → HARD FAIL（抛错）。
 * 这是 createOrder PO 路径的入口映射：真相只从 approved 冻结快照来。
 *
 * @throws Error('snapshot_not_approved') 当 basis 非 consumable/approved
 * @throws Error('snapshot_version_mismatch') 当版本与 PO 绑定版不一致
 */
export function buildOrderFromPO(po: CustomerPoLike, basis: CompareBasis): OrderDraftFromPO {
  if (!basis.consumable || !basis.isApproved || basis.basis !== 'approved' || !basis.snapshot) {
    throw new Error('snapshot_not_approved');
  }
  if (basis.snapshotVersion !== po.quote_snapshot_version) {
    throw new Error('snapshot_version_mismatch');
  }
  return buildOrderDraftFromPO(po, basis.snapshot, { priceFloor: basis.priceFloor });
}
