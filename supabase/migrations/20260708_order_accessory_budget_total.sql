-- ========================================================================
-- 采购核料 · 整单辅料总价一口价(2026-07-08 用户拍板:辅料业务单个计算但很琐碎,
--   按不同要求合并成一口价 → 不逐款、不逐个填,整单一个「辅料总价」)
-- ========================================================================
-- 之前辅料预算走 order_cost_baseline.quote_style_budgets 的逐款 trim_budget(单件×件数),
-- 现改为整单一口价:辅料预算 = 本列(不乘件数)。加工费 cmt 仍逐款(元/件)存 quote_style_budgets。
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.order_cost_baseline
  ADD COLUMN IF NOT EXISTS accessory_budget_total numeric;

COMMENT ON COLUMN public.order_cost_baseline.accessory_budget_total IS
  '整单辅料总价(业务在采购核料填的一口价):辅料预算=本列(不乘件数)。取代逐款 quote_style_budgets.trim_budget。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='order_cost_baseline' AND column_name='accessory_budget_total';  -- 期望 1 行
-- 回滚:ALTER TABLE public.order_cost_baseline DROP COLUMN accessory_budget_total;
-- ========================================================================
