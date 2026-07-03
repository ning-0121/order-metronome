-- ========================================================================
-- 物料主数据:加参考价(不含税净价) + 放开类别/BOM物料类型 CHECK(允许自定义类别)
-- ========================================================================
-- 用户需求:新建物料去掉默认供应商 → 改为「参考价(不含税净价)」;类别可自定义添加。
-- 类别 CHECK 原限 8 值,materials_bom.material_type 限 10 值 → 放开为任意文本,
-- 下游对未知类别优雅降级(标签显示原文/单独归组/不自动识别主面料)。app 仍默认已知值。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

-- 1) 参考价(不含税净价)。单价口径,采购建议价的参考基线。
ALTER TABLE public.material_master
  ADD COLUMN IF NOT EXISTS reference_price numeric;   -- 不含税净价(参考)
COMMENT ON COLUMN public.material_master.reference_price IS '参考价·不含税净价(单价);采购下单前参考,非底价';

-- 2) 放开 material_master.category CHECK(动态找约束名,抗非默认命名)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'public.material_master'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%category%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.material_master DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- 3) 放开 materials_bom.material_type CHECK(选自定义类别的物料入 BOM 时不报错)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'public.materials_bom'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%material_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.materials_bom DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- ========================================================================
-- 验证(逐条,期望值见注释)
-- ========================================================================
-- ① 期望 1 行 reference_price | numeric:
-- select column_name, data_type from information_schema.columns
--  where table_name='material_master' and column_name='reference_price';
-- ② 期望 0 行(两个 category/material_type CHECK 都已删):
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid in ('public.material_master'::regclass,'public.materials_bom'::regclass)
--    and contype='c' and (pg_get_constraintdef(oid) ilike '%category%' or pg_get_constraintdef(oid) ilike '%material_type%');

-- ========================================================================
-- 回滚
-- ========================================================================
-- ALTER TABLE public.material_master DROP COLUMN IF EXISTS reference_price;
-- ALTER TABLE public.material_master ADD CONSTRAINT material_master_category_check
--   CHECK (category IN ('fabric','trim','packing','print','washing','embroidery','service','other'));
-- ALTER TABLE public.materials_bom ADD CONSTRAINT materials_bom_material_type_check
--   CHECK (material_type IN ('fabric','trim','lining','label','packing','print','washing','embroidery','service','other'));
