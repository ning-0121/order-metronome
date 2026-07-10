-- ========================================================================
-- 采购核料 · 产品明细拆分「款号×颜色×尺码」(2026-07-10 用户拍板)
--   吊牌/洗唛/条码 等辅料印着产品的款号·颜色·尺码信息 → 供应商必须分 SKU 印,
--   采购量要拆到「款号×颜色×尺码」粒度,不能只给整单总数。
-- ========================================================================
-- 数据来源=订单本身的 SKU 件数矩阵(order_line_items:一行一款一色 + sizes),
-- 按最终采购量(人拍板)比例分配,采购可微调。存本列作确认时的派生快照(Evidence,
-- 非新真相源;真相仍在 order_line_items)。
--
-- 形如:[{"style_no":"A01","product_name":"卫衣","color_cn":"黑","color_en":"BLACK",
--        "size":"M","qty":1200}, ...]。NULL = 不按产品拆(现状)。
--
-- 与 size_qty_override 的关系:非空时,系统把各码合计回写进 size_qty_override,
-- 于是执行行/收货/财务/主采购单表全按尺码照旧走,无需改动;本列只额外驱动
-- 供应商采购单的「产品明细(款×色×码)」附页。二者互斥(手动改尺码会清空本列)。
--
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS sku_breakdown jsonb;

COMMENT ON COLUMN public.procurement_items.sku_breakdown IS
  '产品明细拆分(款号×颜色×尺码),采购在核料预览填,派生自 order_line_items:[{style_no,product_name,color_cn,color_en,size,qty}]。非空时各码合计回写 size_qty_override 驱动执行/收货/财务,本列额外驱动采购单产品明细附页。NULL=不按产品拆。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='procurement_items' AND column_name='sku_breakdown';  -- 期望 1 行
-- 回滚:ALTER TABLE public.procurement_items DROP COLUMN sku_breakdown;
-- ========================================================================
