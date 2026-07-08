-- ========================================================================
-- 采购核料 · 尺码拆分人工覆盖(2026-07-08 用户拍板:采购要能在预览里直接改
--   尺码比 / 每个尺码的具体数量,不用等生成执行行后再去采购队列逐个改)
-- ========================================================================
-- 默认按订单各码件数比例拆分(distributeBySize)。人填了本列 → 生成执行行时按本列逐码出量,
-- 不再自动按比例拆。形如 {"S":2575,"M":2600,"L":2325};最终采购量 = 各码之和。
-- 清空(NULL)= 恢复系统按比例拆分。纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS size_qty_override jsonb;

COMMENT ON COLUMN public.procurement_items.size_qty_override IS
  '尺码拆分人工覆盖(采购在核料预览填):{尺码:数量}。非空则生成执行行按此逐码出量,不按比例自动拆;最终采购量=各码之和。NULL=系统按比例拆。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='procurement_items' AND column_name='size_qty_override';  -- 期望 1 行
-- 回滚:ALTER TABLE public.procurement_items DROP COLUMN size_qty_override;
-- ========================================================================
