-- ========================================================================
-- 报价基线(逐料)· 冻结的成本单一真相(2026-07-04)
-- ========================================================================
-- 内部报价单 = 成本基线,必须冻结保存,供三点对照:
--   ① BOM 录单耗 vs 报价单耗   ② 核料大货单耗/采购价 vs 报价单耗/单价
--   ③ 财务:报价 → 预算单
-- 现有 order_cost_baseline 是"每单一行·单面料"口径(fabric_consumption_kg/
-- fabric_price_per_kg/cmt_factory_quote),不足以承载"逐料(含辅料)的单耗+单价"。
-- 纯加法:加一个 jsonb 逐料基线 + 冻结标记,复用该表现成 RLS,不另造表。
--
-- quote_baseline_lines 每条:
--   { material_name, category, color, quote_consumption(报价单耗/单件用量),
--     quote_unit_price(报价单价·冻结·超价对照用), quote_unit, notes }
-- 加工费沿用现有列 cmt_factory_quote。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.order_cost_baseline
  ADD COLUMN IF NOT EXISTS quote_baseline_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS baseline_frozen_at   timestamptz,
  ADD COLUMN IF NOT EXISTS baseline_frozen_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.order_cost_baseline.quote_baseline_lines IS
  '逐料报价基线(冻结):[{material_name,category,color,quote_consumption,quote_unit_price,quote_unit,notes}]。单一真相,供 BOM/核料/财务对照。';
COMMENT ON COLUMN public.order_cost_baseline.baseline_frozen_at IS '报价基线冻结时间;冻结后即为该单成本对照基线。';

-- ========================================================================
-- 验证:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='order_cost_baseline'
--    AND column_name IN ('quote_baseline_lines','baseline_frozen_at','baseline_frozen_by');
-- 期望 3 行。
-- ========================================================================
-- 回滚:ALTER TABLE public.order_cost_baseline
--   DROP COLUMN quote_baseline_lines, DROP COLUMN baseline_frozen_at, DROP COLUMN baseline_frozen_by;
-- ========================================================================
