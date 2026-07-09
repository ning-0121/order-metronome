-- ===== [2026-07-09] 采购单「价格待定」豁免:显式标记后允许无底价下单(先下单后议价) =====
-- 背景:默认下单必须每行填单价(底价>0),否则 ¥0 的单不该走到下单。
-- 但极少数正当场景(先下单、价格后议)需放行 → 采购显式勾「价格待定」,单上标注,允许无价下单。
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS price_tbd boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.purchase_orders.price_tbd IS
  '价格待定:采购显式勾选后允许无底价下单(先下单后议价),单上标注;默认 false=下单必须填价';

-- 验证(期望 1 行 price_tbd | boolean | NO | false):
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_name='purchase_orders' and column_name='price_tbd';

-- 回滚:
-- ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS price_tbd;
