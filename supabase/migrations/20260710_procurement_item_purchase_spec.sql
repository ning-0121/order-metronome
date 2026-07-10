-- ========================================================================
-- 采购项 · 采购规格(供应商-facing;2026-07-10 用户拍板)
--   业务推采购单只给「每款总数」;采购员在核料页为每个辅料(吊牌/洗标/主标…)
--   补一份「规格」(自由多行文本)+ 图片(已有 image_urls),生成的采购单直接发供应商。
-- ========================================================================
-- 与 specification 分开:specification 是归并派生列、参与 consolidation_key(内部识别);
-- purchase_spec 是采购员自填的供应商规格,不参与归并,只进采购单。纯加法。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS purchase_spec text;

COMMENT ON COLUMN public.procurement_items.purchase_spec IS
  '采购规格(供应商-facing,采购员自填·自由多行):进采购单发供应商,整个辅料一份。不参与归并键,与派生列 specification 分开。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='procurement_items' AND column_name='purchase_spec';  -- 期望 1 行
-- 回滚:ALTER TABLE public.procurement_items DROP COLUMN purchase_spec;
-- ========================================================================
