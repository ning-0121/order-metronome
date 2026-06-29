// GET /api/contract/v1/customers/:qimo_customer_id
// scope: finance.read | commercial.read（无财务字段，两 scope 相同）
// PII 最小化：不返回 email / phone。

import { withContract } from '@/app/api/contract/v1/_lib/withContract';

interface CustomerRow {
  id: string;
  customer_name: string;
  company_name: string | null;
  contact_name: string | null;
  country: string | null;
  customer_code: string | null;
  customer_type: string | null;
  source_araos_company_id: string | null;
}

export const GET = withContract<{ id: string }>(
  { routeTemplate: '/api/contract/v1/customers/:id', entityType: 'customer' },
  async ({ params, supabase }) => {
    const { data } = await supabase
      .from('customers')
      .select('id, customer_name, company_name, contact_name, country, customer_code, customer_type, source_araos_company_id')
      .eq('id', params.id)
      .maybeSingle();

    const c = data as CustomerRow | null;
    if (!c) return null;

    return {
      entityId: c.id,
      data: {
        qimo_customer_id: c.id,
        customer_name: c.customer_name,
        company_name: c.company_name ?? null,
        contact_name: c.contact_name ?? null,
        country: c.country ?? null,
        customer_code: c.customer_code ?? null,
        status: c.customer_type ?? null,
        source: { araos_company_id: c.source_araos_company_id ?? null },
      },
    };
  },
);
