-- ============================================================
-- 多PO合单 P3a — order_amendments 加 po_operation
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- 设计依据: docs/Designs/Multi-PO-PerPO-Operations-P3-V1.0.md 四/五/六
-- ------------------------------------------------------------
-- 性质: 纯加法。给 order_amendments 加 1 列 po_operation(jsonb)。
--   非空 = 「按来源PO的局部操作」改单(取消/减量/拆分),批准时驱动 applyPoReduction/applyPoSplit。
--   与现有 fields_to_change(表头标量改单)、line_items_delta(加单)并列的第三种改单载荷。
--   结构: { kind: 'cancel_po'|'reduce_po'|'split_po', source_order_po_id, customer_po_number,
--           line_reductions?: [{line_item_id, reduce_sizes, reduce_qty}],   // reduce_po
--           child_internal_order_no?, child_factory_date?, child_etd? }     // split_po
-- 依赖: order_amendments 表(20260402_order_amendments_and_split_shipments.sql)已建。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

ALTER TABLE public.order_amendments
  ADD COLUMN IF NOT EXISTS po_operation jsonb;

COMMENT ON COLUMN public.order_amendments.po_operation IS
  'P3:按来源PO的局部操作载荷(cancel_po/reduce_po/split_po)。非空时批准驱动 applyPoReduction/applyPoSplit;与 fields_to_change/line_items_delta 并列。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 列存在且可空(期望 1 行, jsonb, YES)
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_amendments' AND column_name='po_operation';
--
-- [2] 老数据全为空(期望 non_null=0)
-- SELECT count(po_operation) AS non_null FROM public.order_amendments;
-- ============================================================
