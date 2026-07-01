/**
 * Quote 消费契约 — 纯逻辑层（Consumption Firewall 的可测内核）
 *
 * 这里只放"3 态状态机"的纯决策 + 标准返回类型；不碰 DB、不碰 AI。
 * 对应的 DB 读闸是 app/actions/quote-consumption.ts::getApprovedQuoteForCompare。
 *
 * 唯一真相源：quote_version_snapshot（不可变冻结版）。
 * consumable=true 只在 STATE ① approved 成立，且 MUST 附带真实 snapshot。
 * NEVER fallback 到 live quoter_quotes / quote_line。
 */

import type { QuoteSnapshot } from './types';

export type CompareBasisState = 'approved' | 'provisional' | 'none';

/** PO/Order 消费 Quote 的标准基线契约（getApprovedQuoteForCompare 的返回形） */
export interface CompareBasis {
  /** 仅 STATE ① 为 true —— PO Compare 唯一可绑定条件 */
  consumable: boolean;
  basis: CompareBasisState;
  quoteId: string;
  snapshotVersion: number | null;
  isApproved: boolean;
  /** 冻结快照（唯一真相）；consumable=true 时 MUST 非 null */
  snapshot: QuoteSnapshot | null;
  /** 审批信封：价格地板（§六 自动过判定用）。DB 可空，故 number | null */
  priceFloor: number | null;
  /** 审批信封：币种。DB 可空，故 string | null */
  currency: string | null;
  /** 诊断用；不参与消费判定 */
  reason?: string;
}

/** 审批信封（仅 meta，绝不含 line/cost/price breakdown） */
export interface QuoteEnvelope {
  approved_version: number | null;
  price_floor: number | null;
  currency: string | null;
}

/** 已取到的冻结快照行（version + jsonb payload） */
export interface SnapshotRow {
  version: number;
  snapshot: QuoteSnapshot;
}

/** 硬阻断：统一构造 consumable=false / basis=none / snapshot=null 的返回 */
export function blockedBasis(
  quoteId: string,
  reason: string,
  priceFloor: number | null = null,
  currency: string | null = null,
): CompareBasis {
  return {
    consumable: false,
    basis: 'none',
    quoteId,
    snapshotVersion: null,
    isApproved: false,
    snapshot: null,
    priceFloor,
    currency,
    reason,
  };
}

/**
 * 3 态状态机（纯函数）：
 *   ① approved_version 有值 且 已取到审批快照 → consumable=true / approved
 *   ② 否则若有任意冻结快照               → consumable=false / provisional（只读预览）
 *   ③ 否则                               → consumable=false / none（硬阻断）
 *
 * 生产级守卫：approved_version 有值但审批快照缺失（数据完整性异常）→ 绝不返回
 * consumable=true+snapshot=null（会污染 PO），降级为 provisional 并打 reason。
 */
export function resolveCompareBasis(
  quoteId: string,
  envelope: QuoteEnvelope | null,
  approvedSnapshot: SnapshotRow | null,
  latestSnapshot: SnapshotRow | null,
): CompareBasis {
  if (!envelope) return blockedBasis(quoteId, 'quote_not_found');

  const { approved_version, price_floor, currency } = envelope;

  // STATE ① APPROVED（唯一 consumable=true）
  if (approved_version != null && approvedSnapshot) {
    return {
      consumable: true,
      basis: 'approved',
      quoteId,
      snapshotVersion: approvedSnapshot.version,
      isApproved: true,
      snapshot: approvedSnapshot.snapshot,
      priceFloor: price_floor,
      currency,
    };
  }

  // STATE ② PROVISIONAL（有冻结快照但未审批 / 审批快照异常缺失）
  if (latestSnapshot) {
    return {
      consumable: false,
      basis: 'provisional',
      quoteId,
      snapshotVersion: latestSnapshot.version,
      isApproved: false,
      snapshot: latestSnapshot.snapshot,
      priceFloor: price_floor,
      currency,
      reason: approved_version != null ? 'approved_snapshot_missing' : undefined,
    };
  }

  // STATE ③ NONE（无任何冻结快照 → 硬阻断，NEVER fallback 到 live quote）
  return blockedBasis(quoteId, 'no_snapshot', price_floor, currency);
}
