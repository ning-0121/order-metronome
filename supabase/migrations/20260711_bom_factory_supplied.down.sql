-- 回滚 20260711_bom_factory_supplied.sql
ALTER TABLE public.materials_bom
  DROP COLUMN IF EXISTS factory_supplied;
