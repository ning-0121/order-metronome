-- ===== 2026-04-07 订单灵活性增强 =====

-- 1. 跳过产前样（某些客户直接用设计样做大货）
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS skip_pre_production_sample boolean DEFAULT false;

-- 2. 样品确认天数（某些客户确认慢，需要预留更多时间）
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sample_confirm_days_override integer;

-- 3. 多工厂生产（分厂区生产的订单）
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS factory_ids text[];
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS factory_names text[];

-- 4. 客户层面的样品确认天数默认值（后续新订单自动应用）
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS default_sample_confirm_days integer;

COMMENT ON COLUMN public.orders.skip_pre_production_sample IS '跳过产前样节点（客户直接用设计样）';
COMMENT ON COLUMN public.orders.sample_confirm_days_override IS '样品确认预留天数（覆盖默认19天）';
COMMENT ON COLUMN public.orders.factory_ids IS '多工厂生产：工厂ID数组（分厂区生产）';
COMMENT ON COLUMN public.customers.default_sample_confirm_days IS '客户样品确认默认天数（新订单自动应用）';
