-- ========================================================================
-- 采购核料 · 面料预算单价(2026-07-08 用户拍板:弃用报价单识别/报价基线,
--   预算改由业务在「采购核料」按真实物料直接填)
-- ========================================================================
-- 之前预算来自报价单解析(报价基线),报价单里的布料名(如"仿锦")和采购系统真名
-- (如"280g直贡呢")对不上 → 预算永远配不上实际,超预算/对账失效。
-- 改为:业务在采购核料的物料行直接填【预算单价】,配合已有的【大货单耗(production_consumption)】,
--   面料预算 = 大货单耗 × 预算单价 × 件数,用的就是采购真实物料,名恒对齐。
-- 加工费/辅料单件总价按款存 order_cost_baseline.quote_style_budgets(复用,不新建表)。
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS budget_unit_price numeric;

COMMENT ON COLUMN public.materials_bom.budget_unit_price IS
  '预算单价(业务在采购核料填):面料预算=大货单耗×本列×件数。取代报价基线的报价单价。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='materials_bom' AND column_name='budget_unit_price';   -- 期望 1 行
-- 回滚:ALTER TABLE public.materials_bom DROP COLUMN budget_unit_price;
-- ========================================================================
