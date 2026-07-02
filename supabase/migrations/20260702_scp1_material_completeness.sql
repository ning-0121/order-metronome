-- ========================================================================
-- QIMO SCM OS — SC-P1 物料 OS 完整(多供应商图 + 单位换算 + 替代物料 + 物料级安全库存)
-- ========================================================================
-- 依据: docs/Designs/SCM-OS-Completion-Blueprint-V1.md §B(P1)。ADR-004 采购五层。
-- 性质: 纯加法。3 张新表(全空)+ material_master 加 3 个可空列。
--   不动 material_master 既有列/既有采购/库存流;新对象只引用既有真相(material_master / suppliers)。
--   注: 类别层级(parent category)不在本迁移 —— 需单独 material_category 表,现扁平 category 枚举够用。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

-- ── 1) material_supplier:物料 ↔ 多供应商(价/期/MOQ/优先)──
CREATE TABLE IF NOT EXISTS public.material_supplier (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id  uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  supplier_id         uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  unit_price          numeric,                                 -- 该供应商此物料报价(大货底价,采购/财务口径)
  currency            text DEFAULT 'CNY',
  lead_days           int,                                     -- 该供应商此物料交期
  moq                 numeric,
  purchase_unit       text,
  is_preferred        boolean NOT NULL DEFAULT false,          -- 首选供应商(打分默认加权)
  last_quoted_at      date,
  note                text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_master_id, supplier_id)                     -- 一物料一供应商一行
);
CREATE INDEX IF NOT EXISTS idx_matsup_material  ON public.material_supplier(material_master_id);
CREATE INDEX IF NOT EXISTS idx_matsup_supplier  ON public.material_supplier(supplier_id);
CREATE INDEX IF NOT EXISTS idx_matsup_preferred ON public.material_supplier(material_master_id) WHERE is_preferred = true;
COMMENT ON TABLE public.material_supplier IS '物料↔供应商映射(多供应商图)。unit_price=大货底价(业务屏蔽)。供应商打分/建议下单的来源。';

-- ── 2) material_uom:单位换算(1 from_unit = factor to_unit)──
CREATE TABLE IF NOT EXISTS public.material_uom (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id  uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  from_unit           text NOT NULL,
  to_unit             text NOT NULL,
  factor              numeric NOT NULL CHECK (factor > 0),     -- 1 from_unit = factor to_unit
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_master_id, from_unit, to_unit)
);
CREATE INDEX IF NOT EXISTS idx_uom_material ON public.material_uom(material_master_id);
COMMENT ON TABLE public.material_uom IS '物料单位换算(kg/m/pcs 等)。1 from_unit = factor to_unit。';

-- ── 3) material_alternative:替代/等效物料图 ──
CREATE TABLE IF NOT EXISTS public.material_alternative (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_master_id      uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  alt_material_master_id  uuid NOT NULL REFERENCES public.material_master(id) ON DELETE CASCADE,
  relation                text NOT NULL DEFAULT 'substitute'
                          CHECK (relation IN ('equivalent','substitute','upgrade')),
  ratio                   numeric NOT NULL DEFAULT 1 CHECK (ratio > 0),  -- 用量比(1 主 = ratio 替代)
  note                    text,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_alt_not_self CHECK (material_master_id <> alt_material_master_id),
  UNIQUE (material_master_id, alt_material_master_id)
);
CREATE INDEX IF NOT EXISTS idx_alt_material ON public.material_alternative(material_master_id);
COMMENT ON TABLE public.material_alternative IS '替代/等效/升级物料关系图。ratio=用量比。断料时供替代建议。';

-- ── 4) material_master 加物料级库存策略列(P3 补货引擎用;纯加法,可空)──
ALTER TABLE public.material_master
  ADD COLUMN IF NOT EXISTS safety_stock_qty numeric,          -- 安全库存
  ADD COLUMN IF NOT EXISTS reorder_point    numeric,          -- 再订货点(available < 此 → 触发补货)
  ADD COLUMN IF NOT EXISTS max_stock        numeric;          -- 最高库存(补到此)

-- ── 5) RLS(登录可读/写;写权限在 server action 层按能力 material.manage 把关)──
ALTER TABLE public.material_supplier    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_uom         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_alternative ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS matsup_sel ON public.material_supplier;
CREATE POLICY matsup_sel ON public.material_supplier FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS matsup_ins ON public.material_supplier;
CREATE POLICY matsup_ins ON public.material_supplier FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS matsup_upd ON public.material_supplier;
CREATE POLICY matsup_upd ON public.material_supplier FOR UPDATE USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS matsup_del ON public.material_supplier;
CREATE POLICY matsup_del ON public.material_supplier FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS uom_sel ON public.material_uom;
CREATE POLICY uom_sel ON public.material_uom FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS uom_ins ON public.material_uom;
CREATE POLICY uom_ins ON public.material_uom FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS uom_upd ON public.material_uom;
CREATE POLICY uom_upd ON public.material_uom FOR UPDATE USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS uom_del ON public.material_uom;
CREATE POLICY uom_del ON public.material_uom FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS alt_sel ON public.material_alternative;
CREATE POLICY alt_sel ON public.material_alternative FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS alt_ins ON public.material_alternative;
CREATE POLICY alt_ins ON public.material_alternative FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS alt_upd ON public.material_alternative;
CREATE POLICY alt_upd ON public.material_alternative FOR UPDATE USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS alt_del ON public.material_alternative;
CREATE POLICY alt_del ON public.material_alternative FOR DELETE USING (auth.uid() IS NOT NULL);

-- ========================================================================
-- 验证 SQL(执行后单独跑,期望值见注释)
-- ========================================================================
-- [1] 3 张新表存在(期望 3 行)
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public'
--   AND table_name IN ('material_supplier','material_uom','material_alternative');
--
-- [2] material_master 3 个新列(期望 3 行)
-- SELECT column_name FROM information_schema.columns WHERE table_name='material_master'
--   AND column_name IN ('safety_stock_qty','reorder_point','max_stock');
--
-- [3] material_supplier 的 2 个 FK 指向正确(期望 material_master + suppliers 各 1)
-- SELECT conname, confrelid::regclass AS ref FROM pg_constraint
--   WHERE conrelid='public.material_supplier'::regclass AND contype='f';
--
-- [4] 唯一约束存在(期望 3 行:每表 1 个 unique)
-- SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
--   WHERE conrelid IN ('public.material_supplier'::regclass,'public.material_uom'::regclass,'public.material_alternative'::regclass)
--     AND contype='u';
--
-- [5] RLS 已启用(期望 3 行 t)
-- SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('material_supplier','material_uom','material_alternative');
--
-- [6] 新表全空(期望各 0)
-- SELECT (SELECT count(*) FROM material_supplier) a, (SELECT count(*) FROM material_uom) b, (SELECT count(*) FROM material_alternative) c;

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净)
-- ========================================================================
-- DROP TABLE IF EXISTS public.material_alternative;
-- DROP TABLE IF EXISTS public.material_uom;
-- DROP TABLE IF EXISTS public.material_supplier;
-- ALTER TABLE public.material_master
--   DROP COLUMN IF EXISTS safety_stock_qty, DROP COLUMN IF EXISTS reorder_point, DROP COLUMN IF EXISTS max_stock;
