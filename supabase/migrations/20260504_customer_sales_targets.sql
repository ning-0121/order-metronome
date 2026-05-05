-- ===== 2026-05-04 客户年度销售目标 =====
-- CEO/admin 设置客户的年度销售目标（CNY），系统自动计算进度
-- 销售和财务可以查看自己负责的客户（凭 orders.owner_user_id 关联）

CREATE TABLE IF NOT EXISTS public.customer_sales_targets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  year int NOT NULL CHECK (year >= 2020 AND year <= 2100),
  target_amount_cny numeric(14, 2) NOT NULL CHECK (target_amount_cny > 0),
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(customer_id, year)
);

CREATE INDEX IF NOT EXISTS idx_cst_customer ON public.customer_sales_targets(customer_id);
CREATE INDEX IF NOT EXISTS idx_cst_year     ON public.customer_sales_targets(year);

ALTER TABLE public.customer_sales_targets ENABLE ROW LEVEL SECURITY;

-- 读：任意已登录用户（应用层会按"自己负责的客户"过滤）
DROP POLICY IF EXISTS "cst_select_authenticated" ON public.customer_sales_targets;
CREATE POLICY "cst_select_authenticated" ON public.customer_sales_targets
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 写：仅管理员
DROP POLICY IF EXISTS "cst_admin_write" ON public.customer_sales_targets;
CREATE POLICY "cst_admin_write" ON public.customer_sales_targets
  FOR ALL USING (public.is_admin_user(auth.uid()));

COMMENT ON TABLE  public.customer_sales_targets IS 'CEO 设置的客户年度销售目标（CNY）';
COMMENT ON COLUMN public.customer_sales_targets.target_amount_cny IS '年度目标金额（人民币元）';
