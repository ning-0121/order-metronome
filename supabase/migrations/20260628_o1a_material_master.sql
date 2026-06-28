-- ========================================================================
-- QIMO OS O1a — Material Master + materials_bom 链接列(定稿)
-- ========================================================================
-- 建公司级物料主数据 material_master(含临时物料 is_temporary);materials_bom 加 master 链接 + 特殊要求列。
-- 纯加法、幂等、不灌数据(种子另跑 dry-run 审过后再 execute)、不动 B0/B1/采购流。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行、未 push。
-- ========================================================================

-- ── 1) material_master:公司级可复用物料主数据 ──
CREATE TABLE IF NOT EXISTS public.material_master (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_code         text,                                   -- 编码(可空,正式物料赋码;UNIQUE 见下)
  material_name         text NOT NULL,
  category              text CHECK (category IN
                        ('fabric','trim','packing','print','washing','embroidery','service','other')),
  default_unit          text,                                   -- kg/pcs/m/yard
  default_consumption   numeric,                                -- 默认单耗(可空,每单可覆盖)
  default_supplier_name text,                                   -- 默认供应商(文本,与采购口径一致)
  default_lead_days     int,                                    -- 默认交期(喂 B1 supplier_profile,V2.1 §8b)
  specification         text,                                   -- 规格(成分/克重/纱支)
  default_loss_rate     numeric,                                -- 默认损耗%
  image_url             text,                                   -- 物料图(证据,不参与计算)
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','archived')),
  -- ── 临时物料(控制点 A)──
  is_temporary          boolean NOT NULL DEFAULT false,         -- true=临时(未沉淀为公司主数据)
  source_order_id       uuid REFERENCES public.orders(id) ON DELETE SET NULL,  -- 临时物料来源订单
  promoted_at           timestamptz,                            -- 转正时间
  promoted_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- ── 溯源 + 统计 ──
  seed_source           text,                                   -- trim_library / fabric_records / manual / order_entry
  usage_count           int NOT NULL DEFAULT 0,                 -- 被多少订单用过(排序)
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- 编码唯一(仅当非空;临时物料可无码)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mm_code ON public.material_master(material_code) WHERE material_code IS NOT NULL;
-- 搜索/去重(名称+类别)
CREATE INDEX IF NOT EXISTS idx_mm_name_cat ON public.material_master(lower(material_name), category);
CREATE INDEX IF NOT EXISTS idx_mm_category ON public.material_master(category) WHERE status='active' AND is_temporary=false;
CREATE INDEX IF NOT EXISTS idx_mm_temp     ON public.material_master(is_temporary) WHERE is_temporary=true;

-- ── 2) materials_bom 加链接列(Material Package 行引用 Master + 本单特殊要求)──
ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS material_master_id   uuid REFERENCES public.material_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS special_requirements text;
CREATE INDEX IF NOT EXISTS idx_mb_master_id ON public.materials_bom(material_master_id);

-- ── 3) RLS(登录可读/可创建;改正式主数据+转正受控,在 server action 里按角色把关)──
ALTER TABLE public.material_master ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mm_sel ON public.material_master;
CREATE POLICY mm_sel ON public.material_master FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mm_ins ON public.material_master;
CREATE POLICY mm_ins ON public.material_master FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mm_upd ON public.material_master;
CREATE POLICY mm_upd ON public.material_master FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ========================================================================
-- 验证 SQL(执行后单独跑)
-- ========================================================================
-- SELECT table_name FROM information_schema.tables WHERE table_name='material_master';  -- 期望 1 行
-- SELECT column_name FROM information_schema.columns WHERE table_name='materials_bom' AND column_name IN ('material_master_id','special_requirements');  -- 期望 2 行
-- SELECT count(*) FROM material_master;  -- 期望 0(种子另跑 dry-run 审过后才导入)

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净)
-- ========================================================================
-- ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS material_master_id;
-- ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS special_requirements;
-- DROP TABLE IF EXISTS public.material_master;
