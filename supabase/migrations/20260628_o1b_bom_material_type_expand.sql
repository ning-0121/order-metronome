-- ========================================================================
-- QIMO OS O1b — 扩容 materials_bom.material_type CHECK(定稿)
-- ========================================================================
-- 目的:让 master.category(8 值)能原样写进 materials_bom.material_type,
--       使「从物料库选择」录入的 print/washing/embroidery/service 物料,
--       经 B1 → MRP(MATERIAL_TYPE_TO_CATEGORY 已支持这 10 个值)正确分类。
-- 原 CHECK 仅 6 值(fabric/trim/lining/label/packing/other),新增 4 值。
-- 纯加法(新值是旧值的超集)、幂等、向后兼容、不改数据、不动 B0/B1/采购流。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

-- ── 1) 删除现有 material_type 上的 CHECK(动态找名,抗"约束名非默认名")──
--    旧表 inline CHECK 默认名应为 materials_bom_material_type_check,
--    但若历史上被改名,简单 DROP IF EXISTS 会静默失效、留下旧 6 值约束 →
--    以后插 print/washing 行运行时报 CHECK 违反。这里动态枚举彻底清掉。
DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.materials_bom'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%material_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.materials_bom DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

-- ── 2) 加新 CHECK(原 6 值 + print/washing/embroidery/service = 10 值)──
ALTER TABLE public.materials_bom
  ADD CONSTRAINT materials_bom_material_type_check
  CHECK (material_type IN
    ('fabric','trim','lining','label','packing','print','washing','embroidery','service','other'));

-- ========================================================================
-- 验证 SQL(执行后单独跑)
-- ========================================================================
-- 期望:CHECK 定义里含全部 10 个值(尤其 print/washing/embroidery/service)
-- SELECT conname, pg_get_constraintdef(oid) AS def
--   FROM pg_constraint
--  WHERE conrelid='public.materials_bom'::regclass AND contype='c'
--    AND pg_get_constraintdef(oid) ILIKE '%material_type%';
--
-- 期望:现有 BOM 行不受影响(material_type 全是旧 6 值子集,无违反)
-- SELECT material_type, count(*) FROM materials_bom GROUP BY material_type ORDER BY 1;

-- ========================================================================
-- 回滚 SQL(仅当无行使用 print/washing/embroidery/service 时才安全)
-- ========================================================================
-- ALTER TABLE public.materials_bom DROP CONSTRAINT IF EXISTS materials_bom_material_type_check;
-- ALTER TABLE public.materials_bom ADD CONSTRAINT materials_bom_material_type_check
--   CHECK (material_type IN ('fabric','trim','lining','label','packing','other'));
