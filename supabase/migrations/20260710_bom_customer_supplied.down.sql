-- 回滚 20260710_bom_customer_supplied.sql
ALTER TABLE public.materials_bom
  DROP COLUMN IF EXISTS customer_supplied;
