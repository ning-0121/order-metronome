-- ========================================================================
-- 富录入明细:款式英文描述 + 每色箱数(2026-07-03,生产任务单辉念版式需要)
-- ========================================================================
-- 生产任务单 V3(按用户提供的辉念工厂模板)明细表需要:
--   款式双语描述(中文 product_name 已有 → 加 product_name_en)
--   双语颜色(color_cn/color_en 已有,无需改)
--   箱数(每色一行 → carton_count)
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS product_name_en text,   -- 款式英文描述(双语描述的 EN 半边)
  ADD COLUMN IF NOT EXISTS carton_count    int;    -- 箱数(该色行)

COMMENT ON COLUMN public.order_line_items.product_name_en IS '款式英文描述;生产任务单/PI 双语用';
COMMENT ON COLUMN public.order_line_items.carton_count IS '该色行箱数;生产任务单明细表「箱数」列';

-- ========================================================================
-- 验证(期望 2 行):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name='order_line_items' AND column_name IN ('product_name_en','carton_count');
-- ========================================================================
-- 回滚:
-- ALTER TABLE public.order_line_items
--   DROP COLUMN IF EXISTS product_name_en, DROP COLUMN IF EXISTS carton_count;
