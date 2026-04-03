-- ===== 2026-04-03 工厂增加品类/人数/产能字段 =====

ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS product_categories text[] DEFAULT '{}';
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS worker_count integer;
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS monthly_capacity integer;
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS capacity_unit text DEFAULT '件';

COMMENT ON COLUMN public.factories.product_categories IS '生产品类：瑜伽夹克/瑜伽文胸/瑜伽裤子/瑜伽套装/T恤/拉毛裤子/拉毛上衣/梭织上衣/梭织裤子';
COMMENT ON COLUMN public.factories.worker_count IS '工厂人数';
COMMENT ON COLUMN public.factories.monthly_capacity IS '月产能';
COMMENT ON COLUMN public.factories.capacity_unit IS '产能单位（件/套）';
