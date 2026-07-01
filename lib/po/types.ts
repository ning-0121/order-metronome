/**
 * Customer PO — 类型 + 纯逻辑（Phase D 绑定层）
 *
 * PO 是纯绑定容器：只引用 Quote 冻结快照，不拥有任何业务值。
 * 这里放 PO 视图/输入类型 + createPO 的纯门控 evaluatePoCreation（可单测）。
 * 消费真相只经 CompareBasis（getApprovedQuoteForCompare 的返回），永不碰 live quote / quote_line。
 */

import type { QuoteSnapshot } from '@/lib/quoter/types';
import type { CompareBasis } from '@/lib/quoter/consumption';

/** customer_po 行（8 列绑定字段，无价/成本/毛利/行） */
export interface CustomerPoRow {
  id: string;
  po_number: string;
  customer_id: string;
  quote_id: string;
  quote_snapshot_version: number;
  status: string;
  created_at: string;
  updated_at: string;
}

/** createPO 输入 */
export interface CreatePOInput {
  quoteId: string;
  customerId: string;
  poNumber: string;
}

/** getPOView 输出：PO + 冻结快照（唯一真相），不含任何 live quote */
export interface POView {
  po: CustomerPoRow;
  quote_snapshot: QuoteSnapshot | null;
  comparison_ready: boolean;
}

/** createPO 门控判定（纯逻辑结果） */
export interface PoCreationDecision {
  ok: boolean;
  error?: string;
  snapshotVersion?: number;
}

/**
 * createPO 门控（纯函数，无副作用、可单测）。
 * 规则（硬）：
 *   ① consumable=false → 拒绝（draft/provisional/none 都不能绑）
 *   ② consumable=true 但快照/版本缺失 → 拒绝（防御，firewall 不变量本应保证非空）
 *   ③ customerId ≠ snapshot.header.customer_id → 拒绝（防绑错客户）
 * 只依据 CompareBasis + 传入 customerId 判定；不读 DB、不碰 quote 业务逻辑。
 */
export function evaluatePoCreation(basis: CompareBasis, customerId: string): PoCreationDecision {
  if (!basis.consumable) {
    return { ok: false, error: `QUOTE_NOT_CONSUMABLE:${basis.basis}` };
  }
  if (!basis.snapshot) {
    return { ok: false, error: 'SNAPSHOT_MISSING' };
  }
  if (basis.snapshotVersion == null) {
    return { ok: false, error: 'SNAPSHOT_VERSION_MISSING' };
  }
  const snapCustomerId = (basis.snapshot.header as Record<string, unknown>)?.customer_id;
  if (snapCustomerId == null || String(snapCustomerId) !== String(customerId)) {
    return { ok: false, error: 'CUSTOMER_MISMATCH' };
  }
  return { ok: true, snapshotVersion: basis.snapshotVersion };
}
