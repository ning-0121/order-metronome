-- ===== 2026-04-08 客户邮箱补充字段 =====
-- 业务可手动给客户绑定多个邮箱地址，让 email-scan 在客户识别时直接命中
-- 比基于域名的 customer_email_domains 更精准（同一域名下多个客户场景）

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS contact_emails text[] DEFAULT '{}';

COMMENT ON COLUMN public.customers.contact_emails IS
  '业务手动添加的客户联系邮箱列表 — email-scan 识别 from_email 时优先精确匹配';

CREATE INDEX IF NOT EXISTS idx_customers_contact_emails
  ON public.customers USING GIN (contact_emails);
