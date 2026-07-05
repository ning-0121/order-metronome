-- ============================================================
-- order_cost_baseline 补字段 → 供财务预算(quotation.frozen)用
-- 内部成本核算单里有 辅料费用合计 / 人民币含税价 / 面料名 / 面料工厂，
-- 此前 baseline 只存了 面料(净布价/单耗) + 加工(cmt)，没存这几项。
-- 补上后，订单确认时 emit quotation.frozen 才能带全「单件单价」给财务。
-- 加法式，可空，幂等。
-- ============================================================
ALTER TABLE public.order_cost_baseline
  ADD COLUMN IF NOT EXISTS trim_cost_per_piece     numeric NULL,  -- 辅料费用合计(单件)
  ADD COLUMN IF NOT EXISTS selling_price_per_piece numeric NULL,  -- 人民币含税价(单件售价)
  ADD COLUMN IF NOT EXISTS fabric_name             text    NULL,  -- 面料名
  ADD COLUMN IF NOT EXISTS fabric_factory          text    NULL;  -- 面料工厂(供应商)
