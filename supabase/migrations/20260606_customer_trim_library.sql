-- ===== 20260606 Customer Trim Library (Phase 1 of Customer Specification Library) =====
-- [SHARED] 客户×品牌 标准辅料母版库 + materials_bom 落点扩展
-- 原则：库=母版，订单=快照；带入即复制，互不回写。无 tenant_id，无订单 brand 字段。
-- 本文件完全幂等，可安全重复执行（policy 用 DROP IF EXISTS 守护）。

-- ---------- 1. materials_bom：补订单级落点 + 修复带入会触发的 NOT NULL ----------
ALTER TABLE public.materials_bom ADD COLUMN IF NOT EXISTS placement text;
ALTER TABLE public.materials_bom ADD COLUMN IF NOT EXISTS color     text;
ALTER TABLE public.materials_bom ADD COLUMN IF NOT EXISTS spec      text;   -- 决策3：spec 一对一带入

-- 风险1/2：库辅料常无单件用量/物料码；现有 addBomItem 也已在插 null。幂等放宽。
ALTER TABLE public.materials_bom ALTER COLUMN qty_per_piece DROP NOT NULL;
ALTER TABLE public.materials_bom ALTER COLUMN material_code DROP NOT NULL;

-- ---------- 2. customer_trim_library 母版表 ----------
CREATE TABLE IF NOT EXISTS public.customer_trim_library (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_name text NOT NULL,                 -- 键（与 customer_rhythm 一致，松耦合，无 FK）
  brand         text,                          -- 可空 = 该客户通用，不写回订单
  material_name text NOT NULL,
  material_type text NOT NULL DEFAULT 'other'
                CHECK (material_type IN ('fabric','trim','lining','label','packing','other')),
  placement     text,
  color         text,
  qty_per_piece numeric(10,4),                 -- 可空
  unit          text,                          -- 可空，带入时缺省 'meter'
  supplier      text,
  spec          text,
  notes         text,
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 风险3：NULLS NOT DISTINCT，否则 brand/placement/color 为空时拦不住重复（Supabase PG15+）
CREATE UNIQUE INDEX IF NOT EXISTS customer_trim_library_active_unique_idx
  ON public.customer_trim_library (customer_name, brand, material_name, placement, color)
  NULLS NOT DISTINCT
  WHERE active = true;

CREATE INDEX IF NOT EXISTS customer_trim_library_lookup_idx
  ON public.customer_trim_library (customer_name, brand) WHERE active = true;

-- ---------- 3. RLS（决策2：登录即可读写，与 materials_bom 一致） ----------
ALTER TABLE public.customer_trim_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ctl_select_auth" ON public.customer_trim_library;
CREATE POLICY "ctl_select_auth" ON public.customer_trim_library
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "ctl_insert_auth" ON public.customer_trim_library;
CREATE POLICY "ctl_insert_auth" ON public.customer_trim_library
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "ctl_update_auth" ON public.customer_trim_library;
CREATE POLICY "ctl_update_auth" ON public.customer_trim_library
  FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "ctl_delete_auth" ON public.customer_trim_library;
CREATE POLICY "ctl_delete_auth" ON public.customer_trim_library
  FOR DELETE USING (auth.uid() IS NOT NULL);
