-- ========================================================================
-- 采购核料 · 需到日人工锁定(2026-07-08 用户拍板:缺料风险的"需 X 前到"日期
--   不该由系统按 出厂日−供应商交期 自动算,应由采购直接选几月几日到)
-- ========================================================================
-- procurement_items.required_date = 需到日(货到厂日)。采购在核料页选定后锁定,
-- required_date_locked=true → 归并/重算不再用系统倒推值覆盖它。清空锁 → 恢复系统倒推。
-- 需到日驱动缺料风险「需 X 前到」+ 在途灯(computeLineLamp 内部再减交期算最晚下单)。
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS required_date_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.procurement_items.required_date_locked IS
  '需到日人工锁定:true=采购手选了 required_date,归并/重算不覆盖;false=系统按出厂日−交期倒推。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='procurement_items' AND column_name='required_date_locked';  -- 期望 1 行
-- 回滚:ALTER TABLE public.procurement_items DROP COLUMN required_date_locked;
-- ========================================================================
