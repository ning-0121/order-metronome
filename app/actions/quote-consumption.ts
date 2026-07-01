'use server';

/**
 * Quote 消费闸门（Consumption Firewall）—— Quote Domain 唯一只读对外出口。
 *
 * PO / Order 层消费 Quote MUST 只经此函数；严禁 PO 直接读 quoter_quotes / quote_line。
 *
 * 三不原则（锁死）：
 *   - NEVER 把 live quoter_quotes 的价/成本当真相
 *   - NEVER 读 quote_line 当真相
 *   - NEVER 重算 quote（不碰 RAG / 成本引擎）
 * 唯一真相源：quote_version_snapshot（不可变冻结版）。approved 语义仅由 approved_version 派生。
 *
 * 本文件是"薄 DB 壳"：只做读取，决策全交纯函数 resolveCompareBasis（可单测）。
 */

import { createClient } from '@/lib/supabase/server';
import {
  resolveCompareBasis,
  blockedBasis,
  type CompareBasis,
  type SnapshotRow,
} from '@/lib/quoter/consumption';
import type { QuoteSnapshot } from '@/lib/quoter/types';

export async function getApprovedQuoteForCompare(quoteId: string): Promise<CompareBasis> {
  const supabase = await createClient();

  // 认证（RLS 亦强制；此处提前干净失败）
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return blockedBasis(quoteId, 'unauthenticated');

  // Step 1 — 只取审批信封（❌ 不取 line / cost / price breakdown）
  const { data: quote } = await (supabase.from('quoter_quotes') as any)
    .select('id, approved_version, price_floor, currency')
    .eq('id', quoteId)
    .maybeSingle();

  if (!quote) return blockedBasis(quoteId, 'quote_not_found');

  const envelope = {
    approved_version: (quote as any).approved_version ?? null,
    price_floor: (quote as any).price_floor ?? null,
    currency: (quote as any).currency ?? null,
  };

  // STATE ① — approved_version 有值：取该版审批快照（唯一 consumable=true 路径）
  if (envelope.approved_version != null) {
    const { data: approved } = await (supabase.from('quote_version_snapshot') as any)
      .select('version, snapshot')
      .eq('quote_id', quoteId)
      .eq('version', envelope.approved_version)
      .eq('is_approved', true)
      .maybeSingle();

    if (approved) {
      return resolveCompareBasis(quoteId, envelope, approved as SnapshotRow, null);
    }
    // approved_version 有值但快照缺失 → 落到下方 provisional/none（不返回 consumable:true）
  }

  // STATE ②/③ — 取最新冻结快照供 provisional 判定；无则 none
  const { data: latest } = await (supabase.from('quote_version_snapshot') as any)
    .select('version, snapshot')
    .eq('quote_id', quoteId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const latestRow: SnapshotRow | null =
    latest && (latest as any).snapshot
      ? { version: (latest as any).version, snapshot: (latest as any).snapshot as QuoteSnapshot }
      : null;

  return resolveCompareBasis(quoteId, envelope, null, latestRow);
}
