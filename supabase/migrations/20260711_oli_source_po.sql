-- ============================================================
-- 多客户PO合单 — order_line_items 加来源PO溯源列
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- 设计依据: docs/Designs/Multi-PO-Merge-Order-V1.0.md
-- ------------------------------------------------------------
-- 性质: 纯加法。给 order_line_items 加 1 列 source_order_po_id(FK→order_customer_pos)。
--   回答「这一款色来自哪张客户PO」。老数据/单PO单为空 → 完全向后兼容,单PO老路径不受影响。
-- 依赖: 先执行 20260711_order_customer_pos.sql(本列 FK 指向该表)。
-- 口径(用户 2026-07-11 拍板):
--   · 生产单按 款×色×source_order_po_id 分批拆,永不跨PO自动合并求和。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS source_order_po_id uuid
    REFERENCES public.order_customer_pos(id) ON DELETE SET NULL;

-- 生产单/单据按来源PO分组查询用
CREATE INDEX IF NOT EXISTS idx_oli_source_po ON public.order_line_items(source_order_po_id);

COMMENT ON COLUMN public.order_line_items.source_order_po_id IS
  '多PO合单:本明细行来自哪张客户PO(FK→order_customer_pos)。老单/单PO为空,向后兼容。生产单按 款×色×此列 分批拆。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 列存在且可空(期望 1 行, is_nullable=YES)
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_line_items' AND column_name='source_order_po_id';
--
-- [2] FK→order_customer_pos 存在(期望 1 行,含 order_customer_pos + SET NULL)
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='order_line_items' AND con.contype='f'
--   AND pg_get_constraintdef(con.oid) ILIKE '%order_customer_pos%';
--
-- [3] 老数据全为空(期望 count 全部行都 NULL — 建列后未回填时 null_count=total)
-- SELECT count(*) AS total, count(source_order_po_id) AS non_null FROM public.order_line_items;
--   期望: non_null = 0(刚加列,尚无任何行被赋来源PO)
--
-- [4] 索引存在(期望 1 行 idx_oli_source_po)
-- SELECT indexname FROM pg_indexes WHERE tablename='order_line_items' AND indexname='idx_oli_source_po';
-- ============================================================
