'use server';

/**
 * Customer PO — 绑定层（Phase D）
 *
 * PO = "Quote 冻结快照的绑定记录"，不是复制/继承/重算 Quote。
 *
 * 铁律（本文件强制）：
 *   - 消费 Quote MUST 只经 getApprovedQuoteForCompare（消费闸门）
 *   - MUST NOT 读 quoter_quotes(live) / quote_line
 *   - MUST NOT 重算报价 / 不碰 RAG / 成本引擎
 *   - createPO 只写 customer_po 的 5 个绑定字段
 *   - getPOView 只读 customer_po + quote_version_snapshot（冻结快照）
 */

import { createClient } from '@/lib/supabase/server';
import { getApprovedQuoteForCompare } from '@/app/actions/quote-consumption';
import { evaluatePoCreation, type CreatePOInput, type POView, type CustomerPoRow } from '@/lib/po/types';

/**
 * 创建 Customer PO —— 只能绑定 approved 冻结快照。
 */
export async function createPO(input: CreatePOInput): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const quoteId = input.quoteId;
  const customerId = input.customerId;
  const poNumber = input.poNumber?.trim();
  if (!poNumber) return { error: 'PO 号必填' };
  if (!customerId) return { error: '客户必填' };
  if (!quoteId) return { error: '报价必填' };

  // STEP 1 — 消费闸门（唯一入口；内部只读冻结快照 + 审批信封）
  const basis = await getApprovedQuoteForCompare(quoteId);

  // STEP 2/3 — 硬门控：consumable + 客户一致（纯逻辑判定）
  const decision = evaluatePoCreation(basis, customerId);
  if (!decision.ok) return { error: decision.error };

  // STEP 4 — 唯一写：只存绑定字段（无价/成本/毛利/行）
  const { data, error } = await (supabase.from('customer_po') as any)
    .insert({
      po_number: poNumber,
      customer_id: customerId,
      quote_id: quoteId,
      quote_snapshot_version: decision.snapshotVersion,
      status: 'draft',
    })
    .select('id')
    .single();

  if (error) return { error: '创建 PO 失败：' + error.message };
  return { id: (data as any).id };
}

/**
 * 读取 PO 完整视图 —— 只用冻结快照，绝不读 live quote。
 */
export async function getPOView(poId: string): Promise<{ view?: POView; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // load PO
  const { data: po } = await (supabase.from('customer_po') as any)
    .select('*').eq('id', poId).maybeSingle();
  if (!po) return { error: 'PO 不存在' };

  // load snapshot（ONLY frozen；version 绑定）—— 不读 quoter_quotes / quote_line
  const { data: snap } = await (supabase.from('quote_version_snapshot') as any)
    .select('snapshot')
    .eq('quote_id', (po as any).quote_id)
    .eq('version', (po as any).quote_snapshot_version)
    .maybeSingle();

  const quote_snapshot = (snap as any)?.snapshot ?? null;

  return {
    view: {
      po: po as CustomerPoRow,
      quote_snapshot,
      comparison_ready: quote_snapshot != null,
    },
  };
}
