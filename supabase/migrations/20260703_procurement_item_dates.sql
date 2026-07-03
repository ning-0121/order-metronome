-- ========================================================================
-- 核料项到货倒推(2026-07-03 确认归并加强 ④):存 需到日/最晚下单日
-- ========================================================================
-- MRP 需求行本就算好 required_date(该料哪天要到)和 order_by_date(按交期
-- 倒推的最晚下单日)。归并时取各来源最早值存到采购项 → 核料列表直接亮灯:
-- 超最晚下单日=🔥红(今天不下单赶不上),3天内=⏰黄。纯加法。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS required_date  date,   -- 需到日(来源需求最早)
  ADD COLUMN IF NOT EXISTS order_by_date  date;   -- 最晚下单日(来源需求最早)

COMMENT ON COLUMN public.procurement_items.order_by_date IS
  '最晚下单日(MRP按阶段日期−交期天数倒推,取来源最早);过期未确认=赶不上生产';

-- 验证(期望 2 行):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name='procurement_items' AND column_name IN ('required_date','order_by_date');

-- 回滚:
-- ALTER TABLE public.procurement_items
--   DROP COLUMN IF EXISTS required_date, DROP COLUMN IF EXISTS order_by_date;
