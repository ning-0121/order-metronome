-- ========================================================================
-- QIMO OS — Product Domain Phase 1（Digital Product Definition 最小集)(定稿)
-- ========================================================================
-- 范围(用户 2026-06-29 锁定):products / product_variants / product_definitions /
--   product_bom_templates + order_line_items.product_variant_id(可空)。
-- Phase 2 才做:Pattern/Measurement/Sample/TechPack/Printing/Embroidery/Packing/Cost/独立 Version。
-- 设计见 docs/Domains/Product.md。Owner=Product Domain;Product/Variant/Definition/BOMTemplate 均 SoT。
-- 纯加法、幂等、向后兼容。**不碰 O1(materials_bom/material_master)/B1/P1′/线上订单逻辑**;
--   order_line_items 仅加一个可空 FK 列,旧行/旧读写零影响。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行 + 跑 7 项数据库门禁;Claude 不执行、未 push。
-- ========================================================================

-- ── 1) products（款,聚合根;跨订单可复用)──
CREATE TABLE IF NOT EXISTS public.products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code    text,                                   -- 款号(唯一见下,可空草稿)
  product_name    text NOT NULL,
  category        text,                                   -- 服装品类(自由值;Phase1 不约束)
  season          text,
  brand           text,
  target_customer text,
  status          text NOT NULL DEFAULT 'developing'
                  CHECK (status IN ('developing','sampling','confirmed','active','archived')),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_code ON public.products(product_code) WHERE product_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_status ON public.products(status) WHERE status <> 'archived';

-- ── 2) product_variants（市场/客户配置;Order Line 引用它)──
CREATE TABLE IF NOT EXISTS public.product_variants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_code text,
  country      text,
  market       text,
  brand        text,
  customer     text,                                     -- 文本;customer_id 待 Customer Domain 后加 FK(不在 P1)
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued')),
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
  -- Phase 2:fabric_version / package_version / colorway / definition_version_ref / customer_id(FK)
);
CREATE INDEX        IF NOT EXISTS idx_pv_product ON public.product_variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pv_code     ON public.product_variants(product_id, variant_code) WHERE variant_code IS NOT NULL;

-- ── 3) product_definitions（工程/制造/成本真相,版本化)──
CREATE TABLE IF NOT EXISTS public.product_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  version       int  NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','confirmed','active','superseded')),
  confirmed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at  timestamptz,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)                            -- 一款一版本号唯一
);
CREATE INDEX IF NOT EXISTS idx_pd_product ON public.product_definitions(product_id);

-- ── 4) product_bom_templates（款标准 BOM;含开发单耗 + 大货单耗标准)──
CREATE TABLE IF NOT EXISTS public.product_bom_templates (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id           uuid NOT NULL REFERENCES public.product_definitions(id) ON DELETE CASCADE,
  material_master_id      uuid REFERENCES public.material_master(id) ON DELETE SET NULL,  -- → Material 域(只引用)
  material_name           text NOT NULL,
  category                text CHECK (category IN          -- 采购分类(供应链口径,= material 域)
                          ('fabric','trim','packing','print','washing','embroidery','service','other')),
  bom_role                text CHECK (bom_role IN          -- 产品结构角色(≠采购分类,不混)
                          ('main_fabric','lining','trim','packing','print','embroidery','washing','service','other')),
  unit                    text,
  development_consumption numeric,                          -- 开发单耗标准
  production_consumption  numeric,                          -- 大货单耗标准(Definition.Manufacturing;喂采购)
  default_color           text,
  default_placement       text,
  special_requirements    text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbt_definition ON public.product_bom_templates(definition_id);
CREATE INDEX IF NOT EXISTS idx_pbt_master     ON public.product_bom_templates(material_master_id);

-- ── 5) order_line_items 加 product_variant_id(可空,纯加法;不加 order.product_id)──
ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS product_variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_oli_variant ON public.order_line_items(product_variant_id);

-- ── 6) RLS(四张新表:登录读/建/改;不开 DELETE,随父 CASCADE)──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','product_variants','product_definitions','product_bom_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_sel', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (auth.uid() IS NOT NULL)', t||'_sel', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_ins', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (auth.uid() IS NOT NULL)', t||'_ins', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_upd', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (auth.uid() IS NOT NULL)', t||'_upd', t);
  END LOOP;
END $$;

-- ========================================================================
-- 验证 SQL(执行后单独跑)
-- ========================================================================
-- ① 4 张表 + order_line_items 共 5 个对象(期望 products/product_variants/product_definitions/product_bom_templates 都在)
-- SELECT table_name FROM information_schema.tables
--  WHERE table_name IN ('products','product_variants','product_definitions','product_bom_templates') ORDER BY 1;  -- 期望 4 行
--
-- ② order_line_items.product_variant_id 列已加
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='order_line_items' AND column_name='product_variant_id';  -- 期望 1 行
--
-- ③ 关键字段(BOM Template 双单耗 + bom_role;Variant 新增 brand/market)
-- SELECT column_name FROM information_schema.columns WHERE table_name='product_bom_templates'
--   AND column_name IN ('development_consumption','production_consumption','material_master_id','bom_role','category');  -- 期望 5 行
-- SELECT column_name FROM information_schema.columns WHERE table_name='product_variants'
--   AND column_name IN ('brand','market','customer','country');  -- 期望 4 行
--
-- ④ FK + 删除规则(product_variants→products='c'CASCADE;bom_template→material_master='n'SET NULL;oli→product_variants='n')
-- SELECT conrelid::regclass AS tbl, conname, confrelid::regclass AS ref, confdeltype FROM pg_constraint
--  WHERE contype='f' AND conrelid IN ('public.product_variants'::regclass,'public.product_definitions'::regclass,
--        'public.product_bom_templates'::regclass) ORDER BY 1;
-- SELECT conname, confdeltype FROM pg_constraint
--  WHERE conrelid='public.order_line_items'::regclass AND contype='f' AND conname LIKE '%product_variant%';
--
-- ⑤ 四表行数 = 0
-- SELECT (SELECT count(*) FROM products) p,(SELECT count(*) FROM product_variants) v,
--        (SELECT count(*) FROM product_definitions) d,(SELECT count(*) FROM product_bom_templates) b;
--
-- ⑥ RLS 全开(期望 4 行 t)
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('products','product_variants','product_definitions','product_bom_templates') ORDER BY 1;
--
-- ⑦ indexes
-- SELECT tablename, indexname FROM pg_indexes
--  WHERE tablename IN ('products','product_variants','product_definitions','product_bom_templates') ORDER BY 1,2;

-- ========================================================================
-- 回滚 SQL(纯加法,按 FK 逆序;先撤列再删表)
-- ========================================================================
-- DROP INDEX IF EXISTS public.idx_oli_variant;
-- ALTER TABLE public.order_line_items DROP COLUMN IF EXISTS product_variant_id;
-- DROP TABLE IF EXISTS public.product_bom_templates;
-- DROP TABLE IF EXISTS public.product_definitions;
-- DROP TABLE IF EXISTS public.product_variants;
-- DROP TABLE IF EXISTS public.products;
