-- ===== [2026-07-05] order_financials 缺成本基线标记(复审 H1)=====
-- 问题:毛利改组件和现算后,订单无 order_cost_baseline 时 cost_material/cost_cmt=0 →
--   毛利≈100%、min_margin_alert=false(读着像"健康且安全")→ 误导。
-- 修:加 cost_basis_missing 标记。无基线且成本组件全 0 → 置 true、毛利/预警留 null(=待定,
--   而非 false=已核算且安全)。展示层据此显示「缺成本基线·毛利待定」灰标,不渲染百分比。

ALTER TABLE public.order_financials ADD COLUMN IF NOT EXISTS cost_basis_missing boolean NOT NULL DEFAULT false;

-- 缺基线时 margin_pct/min_margin_alert 要写 null(待定,而非 false=安全);确保这两列可空。
ALTER TABLE public.order_financials ALTER COLUMN min_margin_alert DROP NOT NULL;
ALTER TABLE public.order_financials ALTER COLUMN margin_pct DROP NOT NULL;

COMMENT ON COLUMN public.order_financials.cost_basis_missing IS
  '无成本基线且成本组件全为0 → true,此时 margin_pct/min_margin_alert 应为 null(毛利待定,勿当健康)。';

-- 回滚:ALTER TABLE public.order_financials DROP COLUMN IF EXISTS cost_basis_missing;
