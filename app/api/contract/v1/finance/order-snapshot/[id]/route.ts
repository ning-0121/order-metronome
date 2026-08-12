// GET /api/contract/v1/finance/order-snapshot/:qimo_order_id
// 仅 finance.read（commercial → 403）。取代 finance 跨库直连读 orders。
// 含 orders + line_items + quotation(forecast) + milestone 摘要。

import { withContract } from '@/app/api/contract/v1/_lib/withContract';
import { SCOPES } from '@/app/api/contract/v1/_lib/scopes';
import { getCommercialQty, getPhysicalPieceQty, setMultiplierOf, sumCommercialQty, sumPhysicalPieceQty } from '@/lib/domain/line-item-quantity';

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
  qty_pcs: number | null;              // commercial quantity(套装单 = 套数)
  set_multiplier: number | null;       // 每商业单位含多少物理件
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
    // ⚠️ 数量语义(2026-08-12 实证钉死,契约消费方必读):
    //   qty_pcs        = **commercial quantity**(套装单 = 套数)
    //   set_multiplier = 每商业单位含多少物理件
    //   physical       = commercial × set_multiplier
    //   orders.quantity= **physical pieces**;orders.unit_price = 每 **commercial** 单价
    //   ∴ total_amount = unit_price × commercial,**不是** quantity × unit_price(套装单差 N 倍)
    // 旧字段 qty / quantity 保留不动(非破坏),新增显式字段供消费方正确换算。
    const { data: lid } = await supabase
      .from('order_line_items')
      .select('line_no, style_no, color_cn, color_en, sizes, qty_pcs, set_multiplier')
      .eq('order_id', o.id)
      .order('line_no');
    const lineRows = (lid as LineRow[] | null) ?? [];
    const line_items = lineRows.map((l) => ({
      style_no: l.style_no ?? null,
      color: l.color_en ?? l.color_cn ?? null,
      size_breakdown: l.sizes ?? {},
      qty: l.qty_pcs ?? null,                          // 兼容:历史含义 = commercial
      commercial_quantity: getCommercialQty(l),
      set_multiplier: setMultiplierOf(l),
      physical_quantity: getPhysicalPieceQty(l),
    }));
    const commercial_quantity = sumCommercialQty(lineRows) || null;
    const physical_quantity = sumPhysicalPieceQty(lineRows) || null;

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
        quantity: o.quantity ?? null,              // 兼容字段:历史含义 = physical pieces
        // ── 数量语义显式化(2026-08-12,非破坏式新增)──
        // 消费方**不要**用 quantity × unit_price 算金额:两者单位不同(件 vs 每套价)。
        // 需要金额请直接用 total_amount;需要自算请用 commercial_quantity × unit_price。
        commercial_quantity,                        // 商业数量(套装单 = 套数);明细缺失时为 null
        physical_quantity,                          // 物理件数 = Σ(commercial × set_multiplier)
        quantity_basis: 'physical_pieces' as const, // 上面 quantity 字段的口径
        unit_price_basis: 'commercial_unit' as const,
        total_amount_formula: 'unit_price * commercial_quantity' as const,
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
