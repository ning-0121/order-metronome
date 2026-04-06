-- ===== 2026-04-06 客户邮箱域名映射 =====

-- 自动建立 客户名 ↔ 邮箱域名 的关联
CREATE TABLE IF NOT EXISTS public.customer_email_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  email_domain text NOT NULL,
  sample_email text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(customer_name, email_domain)
);

ALTER TABLE public.customer_email_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_email_domains_authenticated" ON public.customer_email_domains
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_customer_email_domains_domain ON public.customer_email_domains(email_domain);
