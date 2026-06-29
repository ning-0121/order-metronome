// GET /api/contract/v1/quotes/:qimo_quote_id
// scope: finance.read（含 cost 块）| commercial.read（cost=null）
// araos 永不得拿 cost / margin（成本真相不外泄获客端）。

import { withContract } from '@/app/api/contract/v1/_lib/withContract';
import { canSeeFinancials } from '@/app/api/contract/v1/_lib/scopes';

interface QuoteRow {
  id: string;
  quote_no: string;
  customer_id: string | null;
  style_no: string | null;
  garment_type: string | null;
  quantity: number | null;
  status: string | null;
  currency: string | null;
  exchange_rate: number | null;
  total_cost_per_piece: number | null;
  quote_price_per_piece: number | null;
  margin_rate: number | null;
}

export const GET = withContract<{ id: string }>(
  { routeTemplate: '/api/contract/v1/quotes/:id', entityType: 'quote' },
  async ({ params, supabase, scope }) => {
    const { data } = await supabase
      .from('quoter_quotes')
      .select('id, quote_no, customer_id, style_no, garment_type, quantity, status, currency, exchange_rate, total_cost_per_piece, quote_price_per_piece, margin_rate')
      .eq('id', params.id)
      .maybeSingle();

    const q = data as QuoteRow | null;
    if (!q) return null;

    return {
      entityId: q.id,
      data: {
        qimo_quote_id: q.id,
        quote_no: q.quote_no,
        qimo_customer_id: q.customer_id ?? null,
        style_no: q.style_no ?? null,
        garment_type: q.garment_type ?? null,
        quantity: q.quantity ?? null,
        status: q.status ?? null,
        cost: canSeeFinancials(scope)
          ? {
              currency: q.currency ?? null,
              exchange_rate: q.exchange_rate ?? null,
              total_cost_per_piece: q.total_cost_per_piece ?? null,
              quote_price_per_piece: q.quote_price_per_piece ?? null,
              margin_rate: q.margin_rate ?? null,
            }
          : null,
      },
    };
  },
);
