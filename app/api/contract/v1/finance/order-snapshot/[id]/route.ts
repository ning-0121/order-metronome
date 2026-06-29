// GET /api/contract/v1/finance/order-snapshot/:qimo_order_id
// 仅 finance.read（commercial → 403）。取代 finance 跨库直连读 orders。
// 含 orders + line_items + quotation(forecast) + milestone 摘要。

import { withContract } from '@/app/api/contract/v1/_lib/withContract';
import { SCOPES } from '@/app/api/contract/v1/_lib/scopes';

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

interface LineRow {
  line_no: number | null;
  style_no: string | null;
  color_cn: string | null;
  color_en: string | null;
  sizes: Record<string, number> | null;
  qty_pcs: number | null;
}

interface QuoteRow {
  currency: string | null;
  exchange_rate: number | null;
  total_cost_per_piece: number | null;
  quote_price_per_piece: number | null;
  margin_rate: number | null;
}

interface MilestoneRow {
  step_key: string;
  name: string;
  status: string;
  sequence_number: number;
}

export const GET = withContract<{ id: string }>(
  {
    routeTemplate: '/api/contract/v1/finance/order-snapshot/:id',
    entityType: 'order-snapshot',
    requiredScope: SCOPES.FINANCE_READ,
  },
  async ({ params, supabase }) => {
    const { data: od } = await supabase
      .from('orders')
      .select('id, order_no, customer_id, origin_quote_id, lifecycle_status, style_no, etd, factory_date, incoterm, payment_terms, currency, unit_price, total_amount, quantity')
      .eq('id', params.id)
      .maybeSingle();

    const o = od as OrderRow | null;
    if (!o) return null;

    // 客户名（按 customer_id）
    let customer_name: string | null = null;
    if (o.customer_id) {
      const { data: cd } = await supabase
        .from('customers')
        .select('customer_name')
        .eq('id', o.customer_id)
        .maybeSingle();
      customer_name = (cd as { customer_name: string } | null)?.customer_name ?? null;
    }

    // 明细行
    const { data: lid } = await supabase
      .from('order_line_items')
      .select('line_no, style_no, color_cn, color_en, sizes, qty_pcs')
      .eq('order_id', o.id)
      .order('line_no');
    const line_items = ((lid as LineRow[] | null) ?? []).map((l) => ({
      style_no: l.style_no ?? null,
      color: l.color_en ?? l.color_cn ?? null,
      size_breakdown: l.sizes ?? {},
      qty: l.qty_pcs ?? null,
    }));

    // 报价（forecast 来源，经 origin_quote_id）
    let quotation: Record<string, unknown> | null = null;
    if (o.origin_quote_id) {
      const { data: qd } = await supabase
        .from('quoter_quotes')
        .select('currency, exchange_rate, total_cost_per_piece, quote_price_per_piece, margin_rate')
        .eq('id', o.origin_quote_id)
        .maybeSingle();
      const q = qd as QuoteRow | null;
      if (q) {
        quotation = {
          currency: q.currency ?? null,
          exchange_rate: q.exchange_rate ?? null,
          total_cost_per_piece: q.total_cost_per_piece ?? null,
          quote_price_per_piece: q.quote_price_per_piece ?? null,
          margin_rate: q.margin_rate ?? null,
        };
      }
    }

    // 里程碑摘要（当前阶段；不返回逐条/审计）
    const { data: msd } = await supabase
      .from('milestones')
      .select('step_key, name, status, sequence_number')
      .eq('order_id', o.id)
      .order('sequence_number');
    const ms = (msd as MilestoneRow[] | null) ?? [];
    const total = ms.length;
    const completed = ms.filter((m) => m.status === 'done').length;
    const current = ms.find((m) => m.status !== 'done') ?? null;
    const milestone_stage = total === 0 ? null : current ? current.name : 'all_done';

    return {
      entityId: o.id,
      data: {
        qimo_order_id: o.id,
        order_no: o.order_no,
        qimo_customer_id: o.customer_id ?? null,
        customer_name,
        lifecycle_status: o.lifecycle_status ?? null,
        milestone_stage,
        milestone: { total, completed, current_step_key: current?.step_key ?? null },
        origin_quote_id: o.origin_quote_id ?? null,
        currency: o.currency ?? null,
        unit_price: o.unit_price ?? null,
        total_amount: o.total_amount ?? null,
        quantity: o.quantity ?? null,
        style_no: o.style_no ?? null,
        etd: o.etd ?? null,
        factory_date: o.factory_date ?? null,
        incoterm: o.incoterm ?? null,
        payment_terms: o.payment_terms ?? null,
        line_items,
        quotation,
      },
    };
  },
);
