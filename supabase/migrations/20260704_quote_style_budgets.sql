-- ========================================================================
-- 报价基线 · 款级预算(2026-07-04 · 报价单每款一行)
-- ========================================================================
-- 内部成本核算单是"每款(STYLE)一行":加工价/面料成本/辅料费用合计 都按款。
-- 原 order_cost_baseline.cmt_factory_quote 只有一个值,不足以承载逐款。
-- 加 jsonb 逐款预算(纯加法,复用该表 RLS)。
-- quote_style_budgets 每条:{ style_no, cmt(加工费), trim_budget(辅料费用合计), fabric_cost(面料成本) }
-- quote_baseline_lines 的对象再加 style_no 字段(jsonb 无需改结构)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.order_cost_baseline
  ADD COLUMN IF NOT EXISTS quote_style_budgets jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.order_cost_baseline.quote_style_budgets IS
  '逐款报价预算(冻结):[{style_no,cmt,trim_budget,fabric_cost}]。供财务报价→预算、辅料超总价对照。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='order_cost_baseline' AND column_name='quote_style_budgets';
-- ========================================================================
-- 回滚:ALTER TABLE public.order_cost_baseline DROP COLUMN quote_style_budgets;
-- ========================================================================
