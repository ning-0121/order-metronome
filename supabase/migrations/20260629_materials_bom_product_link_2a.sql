-- ========================================================================
-- QIMO OS — Product Phase 2A:materials_bom 加 Product 实例化链接 + Override 审计(定稿)
-- ========================================================================
-- 目的(2A):让 Order Material Package(materials_bom)能实例化自 Product BOM Template,
--   并最低限度追踪 Override。**不接采购、不改 B1/P1′ 读取、不建 override 明细表。**
-- 纯加法:仅给 materials_bom 加 5 个可空列 + 1 索引。**不动现有列、不改 RLS。**
--   B1(submitBomToProcurement/snapshot)、P1′(consolidate)读的列全部不变 → 旧行 NULL 零影响。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行 + 跑 7 项数据库门禁;Claude 不执行、未 push。
-- ========================================================================

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS product_bom_template_id uuid
      REFERENCES public.product_bom_templates(id) ON DELETE SET NULL,   -- 实例化自哪条模板(跨域引用,SET NULL 护线上)
  ADD COLUMN IF NOT EXISTS source          text,                         -- 'template'(来自产品模板)/ 'manual'(手动新增);app 控制,旧行 NULL
  ADD COLUMN IF NOT EXISTS override_reason text,                         -- Override 原因(审计)
  ADD COLUMN IF NOT EXISTS overridden_at   timestamptz,                  -- Override 时间
  ADD COLUMN IF NOT EXISTS overridden_by   uuid
      REFERENCES auth.users(id) ON DELETE SET NULL;                      -- Override 人(对齐项目 created_by 口径)

-- 按模板反查实例(并加速 Override 对比)
CREATE INDEX IF NOT EXISTS idx_mb_product_bom_template
  ON public.materials_bom(product_bom_template_id)
  WHERE product_bom_template_id IS NOT NULL;

-- ========================================================================
-- 7 项数据库门禁(执行后逐条跑,真实返回)
-- ========================================================================
-- ① 5 个新列都加上(期望 5 行)
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='materials_bom'
--    AND column_name IN ('product_bom_template_id','source','override_reason','overridden_at','overridden_by');
--
-- ② product_bom_template_id FK → product_bom_templates 且删除规则 = SET NULL(confdeltype='n')
-- SELECT conname, confrelid::regclass AS ref, confdeltype FROM pg_constraint
--  WHERE conrelid='public.materials_bom'::regclass AND contype='f' AND conname LIKE '%product_bom_template%';
--
-- ③ overridden_by FK → auth.users 且删除规则 = SET NULL(confdeltype='n')
-- SELECT conname, confrelid::regclass AS ref, confdeltype FROM pg_constraint
--  WHERE conrelid='public.materials_bom'::regclass AND contype='f' AND conname LIKE '%overridden_by%';
--
-- ④ 索引存在
-- SELECT indexname FROM pg_indexes WHERE tablename='materials_bom' AND indexname='idx_mb_product_bom_template';
--
-- ⑤ B1/P1′ 读的关键列仍在(纯加法没动它们,期望 4 行)
-- SELECT column_name FROM information_schema.columns WHERE table_name='materials_bom'
--    AND column_name IN ('material_name','qty_per_piece','material_master_id','order_id');
--
-- ⑥ 旧行未被回填(新列在既有行上全 NULL;期望 mismatched = 0)
-- SELECT count(*) AS existing_rows,
--        count(product_bom_template_id) AS tpl_set, count(source) AS source_set
--   FROM materials_bom;   -- 期望:tpl_set=0 且 source_set=0(旧行新列全空)
--
-- ⑦ RLS 仍开(加列不影响;期望 t)
-- SELECT relrowsecurity FROM pg_class WHERE relname='materials_bom';

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净;materials_bom 既有数据完好)
-- ========================================================================
-- DROP INDEX IF EXISTS public.idx_mb_product_bom_template;
-- ALTER TABLE public.materials_bom
--   DROP COLUMN IF EXISTS overridden_by,
--   DROP COLUMN IF EXISTS overridden_at,
--   DROP COLUMN IF EXISTS override_reason,
--   DROP COLUMN IF EXISTS source,
--   DROP COLUMN IF EXISTS product_bom_template_id;
