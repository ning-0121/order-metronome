-- ============================================================
-- 经销/采购成品单(trade)—— orders 加采购单价 purchase_unit_cost
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- ------------------------------------------------------------
-- 背景:经销/采购成品单(order_purpose='trade')建单不传内部报价单文件,改填两个单价:
--   · 客户报价单价 → 复用现有 orders.unit_price(应收面,随 order.created 推财务)
--   · 采购单价     → 本列 purchase_unit_cost(成本面);建单时算 采购成本=采购价×数量,
--                    走现有 order.budget_updated 推财务生成预算单成本面。
-- 性质:纯加法,单列。仅 trade 订单用;production/consign 不写(为空)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS purchase_unit_cost numeric(12,2);

COMMENT ON COLUMN public.orders.purchase_unit_cost IS
  '经销/采购成品单(trade)的采购单价(成本面,¥/件)。与 unit_price(客户报价/应收)配对;建单算采购成本×数量推财务预算单。production/consign 为空。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 列存在(期望 1 行, numeric, YES)
-- SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='orders' AND column_name='purchase_unit_cost';
--   期望: purchase_unit_cost / numeric / 12 / 2 / YES
--
-- [2] 老数据全空(期望 non_null=0)
-- SELECT count(purchase_unit_cost) AS non_null FROM public.orders;
-- ============================================================
