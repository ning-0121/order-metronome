-- ===== 2026-05-04 客户年度销售目标改为件数 =====
-- 把目标从 CNY 金额切换为件数，更直接可读，不依赖财务录入
--
-- 兼容两种情况：
--   A. 表不存在 → CREATE TABLE 直接建新结构
--   B. 表已存在（含 target_amount_cny）→ 加新列 + 丢弃旧列

-- 情况 A：建表（如果不存在）
CREATE TABLE IF NOT EXISTS public.customer_sales_targets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  year int NOT NULL CHECK (year >= 2020 AND year <= 2100),
  target_qty bigint NOT NULL CHECK (target_qty > 0),
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(customer_id, year)
);

-- 情况 B：表已存在但列还没切换 → 加 target_qty + 丢 target_amount_cny
ALTER TABLE public.customer_sales_targets
  ADD COLUMN IF NOT EXISTS target_qty bigint;

-- 旧列存在则丢弃（已有的 amount 数据无法直接换算成件数，业主重设即可）
ALTER TABLE public.customer_sales_targets
  DROP COLUMN IF EXISTS target_amount_cny;

-- target_qty 必填 + > 0
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'customer_sales_targets' AND constraint_name = 'customer_sales_targets_target_qty_check'
  ) THEN
    ALTER TABLE public.customer_sales_targets
      ADD CONSTRAINT customer_sales_targets_target_qty_check CHECK (target_qty > 0);
  END IF;
END$$;

-- target_qty 非空（如果已有 NULL 行，先删除——既然旧数据是金额，无法换算，直接丢弃）
DELETE FROM public.customer_sales_targets WHERE target_qty IS NULL;
ALTER TABLE public.customer_sales_targets ALTER COLUMN target_qty SET NOT NULL;

-- 索引（幂等）
CREATE INDEX IF NOT EXISTS idx_cst_customer ON public.customer_sales_targets(customer_id);
CREATE INDEX IF NOT EXISTS idx_cst_year     ON public.customer_sales_targets(year);

-- RLS
ALTER TABLE public.customer_sales_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cst_select_authenticated" ON public.customer_sales_targets;
CREATE POLICY "cst_select_authenticated" ON public.customer_sales_targets
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "cst_admin_write" ON public.customer_sales_targets;
CREATE POLICY "cst_admin_write" ON public.customer_sales_targets
  FOR ALL USING (public.is_admin_user(auth.uid()));

COMMENT ON COLUMN public.customer_sales_targets.target_qty IS '年度目标件数（直接来自 orders.quantity 累加）';
