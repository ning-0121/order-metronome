-- ========================================================================
-- 采购单 · 下单凭证(2026-07-04 用户拍板:下单强制传凭证)
-- ========================================================================
-- 完成下单(draft→placed)前必须上传下单凭证(给供应商的下单截图/付款凭证/回单等),
-- 否则不允许下单。凭证文件走 order-docs 私有桶,这里存路径数组。
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS order_proof_paths jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.purchase_orders.order_proof_paths IS
  '下单凭证文件路径(order-docs 私有桶):下单(placePurchaseOrder)前必须非空,否则拒绝下单。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='purchase_orders' AND column_name='order_proof_paths';   -- 期望 1 行
-- 回滚:ALTER TABLE public.purchase_orders DROP COLUMN order_proof_paths;
-- ========================================================================
