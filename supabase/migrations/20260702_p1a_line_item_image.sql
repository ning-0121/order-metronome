-- ========================================================================
-- P1a 富明细录入 — order_line_items 加 图片 + 备注(纯加法)
-- ========================================================================
-- 生产任务单富录入:每款一张产品图 + 行级备注。喂已有 generateProductionOrder。
-- 性质: 纯加法。既有列/逻辑不动;新列可空,老数据无感。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS image_url text,   -- 每款产品图(同款各颜色行存同一 URL,编辑器在款级管理)
  ADD COLUMN IF NOT EXISTS remark    text;   -- 行级备注(工艺/特殊要求)

-- ========================================================================
-- 验证 SQL(执行后单独跑,期望 2 行)
-- ========================================================================
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='order_line_items' AND column_name IN ('image_url','remark');

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净)
-- ========================================================================
-- ALTER TABLE public.order_line_items DROP COLUMN IF EXISTS image_url, DROP COLUMN IF EXISTS remark;
