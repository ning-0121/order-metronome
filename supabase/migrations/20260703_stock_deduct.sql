-- ========================================================================
-- 库存抵扣量(2026-07-03 用户拍板:抵扣的库存部分要"进采购单标库存·不采购")
-- ========================================================================
-- 采购项某物料需求 = 采购部分(final_purchase_qty,向供应商买) + 库存抵扣部分
--   (stock_deduct_qty,用现有尾料库存,已预留锁定给本单,不采购,发货领用核销)。
-- 抵扣时:reserveStock 预留该量(inventory_reservation,别的单不能再用)+ 记本列;
--   最终采购量减去它;全抵扣(final=0)的项不生成采购执行行=不采购。纯加法。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS stock_deduct_qty numeric;
COMMENT ON COLUMN public.procurement_items.stock_deduct_qty IS
  '库存抵扣量:用现有尾料库存的部分(已预留,不采购,发货领用核销);采购量=需求−此量';

-- 验证(期望 1 行):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='procurement_items' AND column_name='stock_deduct_qty';

-- 回滚:
-- ALTER TABLE public.procurement_items DROP COLUMN IF EXISTS stock_deduct_qty;
