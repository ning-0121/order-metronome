-- ============================================================
-- 经销/采购成品单 —— order_line_items 加逐款采购价 purchase_unit_cost
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- ------------------------------------------------------------
-- 背景:trade 订单不同款采购价不同(有些款同价)。客户报价已逐款(order_line_items.po_unit_price),
--   本列补「逐款采购价(成本面)」。建单算 采购成本=Σ(每款采购价×该款数量) 推财务预算单;
--   应收=Σ(每款客户报价×数量)。同价的款前端一键套用,存的仍是逐款价。
-- 性质:纯加法,单列。trade 用;production/consign 明细为空。
-- 与 orders.purchase_unit_cost(整单版,上一版)并存:逐款为准,整单列保留无害。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS purchase_unit_cost numeric(12,2);

COMMENT ON COLUMN public.order_line_items.purchase_unit_cost IS
  '经销/采购成品单逐款采购单价(成本面,¥/件)。与 po_unit_price(逐款客户报价/应收)配对;建单算采购成本推财务预算单。仅财务/授权角色可见,server 端按口径剥离。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 列存在(期望 1 行, numeric, YES)
-- SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_line_items' AND column_name='purchase_unit_cost';
--   期望: purchase_unit_cost / numeric / 12 / 2 / YES
--
-- [2] 老数据全空(期望 non_null=0)
-- SELECT count(purchase_unit_cost) AS non_null FROM public.order_line_items;
-- ============================================================
