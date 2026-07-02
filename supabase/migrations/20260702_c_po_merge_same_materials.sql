-- ========================================================================
-- C 采购归并确认提示 — 采购单头加「合并同料」标记
-- ========================================================================
-- 建单时勾选行里检测到同 consolidation_key(物料身份+规格+类别+颜色+单位)
-- ≥2 行 → 弹「是否合并」。选择存在 PO 头上:
--   merge_same_materials = true → 导出给供应商的 Excel 同料并为一行(数量/金额求和)。
-- 物理行不动:procurement_line_items 保持一行一订单(order_id peg,核销不受影响)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS merge_same_materials boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.purchase_orders.merge_same_materials IS
  '建单时选「合并同料」:导出 Excel 同 consolidation_key 行并为一行;DB 行不合并';

-- ========================================================================
-- 验证(期望:返回一行 column_name = merge_same_materials)
-- ========================================================================
-- select column_name, data_type, column_default from information_schema.columns
--  where table_name = 'purchase_orders' and column_name = 'merge_same_materials';

-- ========================================================================
-- 回滚
-- ========================================================================
-- ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS merge_same_materials;
