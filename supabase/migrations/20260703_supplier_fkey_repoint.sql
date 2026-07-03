-- ========================================================================
-- 供应商外键改指 suppliers(2026-07-03 事故:归采购单违反 FK)
-- ========================================================================
-- 根因:20260613「factories 当供应商」时代给 procurement_line_items /
--   goods_receipts / procurement_tracking 的 supplier_id 建了 → factories 的
--   外键;20260701 已反转决策新建 suppliers 表,采购单选的是 suppliers.id →
--   归行时 FK 违反("violates procurement_line_items_supplier_id_fkey")。
-- 修:三表外键改指 public.suppliers(id),用 NOT VALID —— 新写入照常校验,
--   存量老行(可能存着 factories id)不回溯校验;Postgres 更新行时若
--   supplier_id 列未变不触发 FK 检查,老行收货/催货照常。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_line_items
  DROP CONSTRAINT IF EXISTS procurement_line_items_supplier_id_fkey;
ALTER TABLE public.procurement_line_items
  ADD CONSTRAINT procurement_line_items_supplier_id_fkey
  FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) NOT VALID;

ALTER TABLE public.goods_receipts
  DROP CONSTRAINT IF EXISTS goods_receipts_supplier_id_fkey;
ALTER TABLE public.goods_receipts
  ADD CONSTRAINT goods_receipts_supplier_id_fkey
  FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) NOT VALID;

ALTER TABLE public.procurement_tracking
  DROP CONSTRAINT IF EXISTS procurement_tracking_supplier_id_fkey;
ALTER TABLE public.procurement_tracking
  ADD CONSTRAINT procurement_tracking_supplier_id_fkey
  FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) NOT VALID;

-- ========================================================================
-- 验证(执行后逐条跑)
-- ========================================================================
-- ① 期望 3 行,且 confrelid 都是 suppliers:
-- SELECT conname, confrelid::regclass AS 指向表 FROM pg_constraint
--  WHERE conname IN ('procurement_line_items_supplier_id_fkey',
--                    'goods_receipts_supplier_id_fkey',
--                    'procurement_tracking_supplier_id_fkey');
-- ② 归单页重试:选供应商+勾行「创建采购单」→ 应成功。

-- ========================================================================
-- 回滚(改回 factories,不建议)
-- ========================================================================
-- 同上三段,REFERENCES public.factories(id)
