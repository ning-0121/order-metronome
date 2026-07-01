-- ========================================================================
-- QIMO OS 供应链域 — B3a 执行链打通:采购执行行挂上采购核料项
-- ========================================================================
-- ADR-004 五层:material_requirements → procurement_items(采购确认)
--   → procurement_line_items(采购执行) ← 本迁移补这条边(1:N 拆单)。
-- Object-Relationship-Map:Procurement Item 1:N Purchase Order = procurement_line_items.procurement_item_id。
-- 只加 1 个可空 FK 列 + 索引。纯加法、幂等。不动现有列/FK/RLS/触发器;新列空,老路径不读它。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

ALTER TABLE public.procurement_line_items
  ADD COLUMN IF NOT EXISTS procurement_item_id uuid
    REFERENCES public.procurement_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pli_procurement_item_id
  ON public.procurement_line_items(procurement_item_id)
  WHERE procurement_item_id IS NOT NULL;

-- ========================================================================
-- 验证 SQL(执行后单独跑,确认加好)
-- ========================================================================
-- 期望 1 行:新列存在,类型 uuid
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='procurement_line_items' AND column_name='procurement_item_id';
--
-- 期望 1 行:FK 指向 procurement_items,删除规则 SET NULL(confdeltype='n')
-- SELECT conname, confrelid::regclass AS ref, confdeltype FROM pg_constraint
--  WHERE conrelid='public.procurement_line_items'::regclass AND contype='f'
--    AND confrelid='public.procurement_items'::regclass;
--
-- 期望 1 行:索引存在
-- SELECT indexname FROM pg_indexes WHERE tablename='procurement_line_items' AND indexname='idx_pli_procurement_item_id';
--
-- 期望:老数据未受影响(新列全 NULL)
-- SELECT count(*) AS total, count(procurement_item_id) AS linked FROM public.procurement_line_items;

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净 —— 新列可空、无业务写入前无引用)
-- ========================================================================
-- DROP INDEX IF EXISTS public.idx_pli_procurement_item_id;
-- ALTER TABLE public.procurement_line_items DROP COLUMN IF EXISTS procurement_item_id;
