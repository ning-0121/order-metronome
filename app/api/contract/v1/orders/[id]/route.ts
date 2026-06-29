// GET /api/contract/v1/orders/:qimo_order_id
// scope: finance.read（含 financial 块）| commercial.read（financial=null）

import { withContract } from '@/app/api/contract/v1/_lib/withContract';
import { canSeeFinancials } from '@/app/api/contract/v1/_lib/scopes';

interface OrderRow {
  id: string;
  order_no: string;
  customer_id: string | null;
  origin_quote_id: string | null;
  lifecycle_status: string | null;
  style_no: string | null;
  etd: string | null;
  factory_date: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  currency: string | null;
  unit_price: number | null;
  total_amount: number | null;
  quantity: number | null;
}

export const GET = withContract<{ id: string }>(
  { routeTemplate: '/api/contract/v1/orders/:id', entityType: 'order' },
  async ({ params, supabase, scope }) => {
    const { data } = await supabase
      .from('orders')
      .select('id, order_no, customer_id, origin_quote_id, lifecycle_status, style_no, etd, factory_date, incoterm, payment_terms, currency, unit_price, total_amount, quantity')
      .eq('id', params.id)
      .maybeSingle();

    const o = data as OrderRow | null;
    if (!o) return null;

    return {
      entityId: o.id,
      data: {
        qimo_order_id: o.id,
        order_no: o.order_no,
        qimo_customer_id: o.customer_id ?? null,
        origin_quote_id: o.origin_quote_id ?? null,
        lifecycle_status: o.lifecycle_status ?? null,
        style_no: o.style_no ?? null,
        etd: o.etd ?? null,
        factory_date: o.factory_date ?? null,
        incoterm: o.incoterm ?? null,
        payment_terms: o.payment_terms ?? null,
        financial: canSeeFinancials(scope)
          ? {
              currency: o.currency ?? null,
              unit_price: o.unit_price ?? null,
              total_amount: o.total_amount ?? null,
              quantity: o.quantity ?? null,
            }
          : null,
      },
    };
  },
);
