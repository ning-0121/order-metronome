-- ============================================================
-- 20260707_procurement_line_size —— 采购执行行「尺码」维度(N1)
-- ============================================================
-- 业务:所有物料的采购行加尺码;逐件辅料(主吊牌/主标/单包袋等)按订单各码件数拆多行分量。
-- 生成执行行时按订单各码件数自动分摊(可改);采购单Excel/来源明细也带尺码。
-- 纯加法。空 size = 不分码(整行,老口径)。
-- ============================================================
ALTER TABLE public.procurement_line_items ADD COLUMN IF NOT EXISTS size text;

COMMENT ON COLUMN public.procurement_line_items.size IS
  '尺码(N1;按订单各码件数拆行时填,如 S/M/L/XL/1XL…)。空=整行不分码。';

CREATE INDEX IF NOT EXISTS idx_pli_item_size ON public.procurement_line_items(procurement_item_id, size);

-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='procurement_line_items' AND column_name='size';  → 1 行
-- 回滚:ALTER TABLE public.procurement_line_items DROP COLUMN IF EXISTS size;
