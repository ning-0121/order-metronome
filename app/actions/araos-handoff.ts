'use server';

/**
 * araos 中标单承接读取(审计 #6 修 2026-07-09):
 * araos 赢单推来的完整规格(order_ref/product_lines/quantity/required_delivery/order_value)落在
 * araos_handoffs_inbox.payload,此前【无任何读取点】→ 业务在节拍器建单只能人肉切回 araos 抄录。
 * 本 action 按客户反查最近一条中标单,供建单入口只读展示参考(定价仍人工确认,不自动建单)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

const str = (v: unknown) => (v == null ? null : String(v).trim() || null);
const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : null; };

export interface AraosHandoffLine { style: string | null; color: string | null; size: string | null; qty: number | null }
export interface AraosHandoffSummary {
  araos_order_id: string | null;
  order_ref: string | null;
  quantity: number | null;
  required_delivery: string | null;
  currency: string | null;
  order_value: number | null;
  note: string | null;
  product_lines: AraosHandoffLine[];
  received_at: string | null;
}

/** 取该客户对应的最近一条 araos 中标单摘要(qimo_customer_id 优先,退回 source_araos_company_id)。无则 data=null。 */
export async function getAraosHandoffForCustomer(customerId: string): Promise<{ data?: AraosHandoffSummary | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!customerId) return { data: null };

  const svc = createServiceRoleClient();
  const pick = 'araos_order_id, payload, received_at';
  let { data: inbox } = await (svc.from('araos_handoffs_inbox') as any)
    .select(pick).eq('qimo_customer_id', customerId)
    .order('received_at', { ascending: false }).limit(1).maybeSingle();
  if (!inbox) {
    const { data: cust } = await (svc.from('customers') as any)
      .select('source_araos_company_id').eq('id', customerId).maybeSingle();
    const src = (cust as any)?.source_araos_company_id;
    if (src) {
      ({ data: inbox } = await (svc.from('araos_handoffs_inbox') as any)
        .select(pick).eq('araos_company_id', src)
        .order('received_at', { ascending: false }).limit(1).maybeSingle());
    }
  }
  if (!inbox) return { data: null };

  const body: any = (inbox as any).payload || {};
  const d: any = body.data && typeof body.data === 'object' ? body.data : body;
  const pl = d?.product_lines;
  const product_lines: AraosHandoffLine[] = Array.isArray(pl)
    ? pl.map((x: any) => (typeof x === 'string'
        ? { style: str(x), color: null, size: null, qty: null }
        : { style: str(x?.style ?? x?.style_no ?? x?.name), color: str(x?.color), size: str(x?.size), qty: num(x?.qty ?? x?.quantity) }))
    : [];
  return {
    data: {
      araos_order_id: (inbox as any).araos_order_id ?? null,
      order_ref: str(d?.order_ref),
      quantity: num(d?.quantity),
      required_delivery: str(d?.required_delivery) ?? str(d?.target_delivery),
      currency: str(d?.currency),
      order_value: num(d?.order_value_usd) ?? num(d?.order_value),
      note: str(d?.spec_notes) ?? str(d?.brand_requirements),
      product_lines,
      received_at: (inbox as any).received_at ?? null,
    },
  };
}
