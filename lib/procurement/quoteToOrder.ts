// ============================================================
// Quote → Order — 纯校验 + 映射（本阶段不创建订单、不写库）
// 输出 origin_quote_id 映射，供订单创建流程在【下一步最小改动】里持久化。
// 铁律: 不 auto-create order、不写库。仅校验 quote 是否可转 + 产出引用映射。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { QuoteToOrderValidation } from './types';

interface QuoteRow {
  id: string;
  quote_no: string;
  status: string | null;
  customer_name: string | null;
  style_no: string | null;
  quantity: number | null;
}

export async function validateQuoteToOrder(
  supabase: SupabaseClient,
  quoteId: string,
): Promise<QuoteToOrderValidation> {
  const { data: qd } = await supabase
    .from('quoter_quotes')
    .select('id, quote_no, status, customer_name, style_no, quantity')
    .eq('id', quoteId)
    .maybeSingle();
  const q = qd as QuoteRow | null;

  if (!q) return { valid: false, reason: 'quote_not_found' };
  if (q.status === 'lost' || q.status === 'abandoned') {
    return { valid: false, reason: `quote_status_${q.status}` };
  }

  // 校验通过 → 产出纯映射（origin_quote_id = quote.id）。不创建订单、不写库。
  return {
    valid: true,
    mapping: {
      origin_quote_id: q.id,
      quote_no: q.quote_no,
      customer_name: q.customer_name ?? '',
      style_no: q.style_no ?? null,
      quantity: q.quantity ?? null,
    },
  };
}
