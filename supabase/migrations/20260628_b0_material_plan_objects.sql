-- ========================================================================
-- QIMO OS 供应链域 V2.1 — B0 三层对象模型(定稿)
-- ========================================================================
-- 只建对象模型地基:material_package_snapshots(+lines) / material_plans / material_requirements
-- + 在现有表加 2 个可空链接列(procurement_line_items.requirement_id / materials_bom.version)。
-- 纯加法、幂等、不写触发器、不灌数据、不动现有采购流。新表全空,无任何业务代码引用。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行、未 push。
-- ========================================================================

-- ── 1) material_package_snapshots:物料包冻结快照(头,工程变更管理 ECM)──
CREATE TABLE IF NOT EXISTS public.material_package_snapshots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  snapshot_no             text,                                   -- 展示号,如 MPS-<order_no>-v1(应用生成)
  version                 int  NOT NULL DEFAULT 1,
  status                  text NOT NULL DEFAULT 'approved'
                          CHECK (status IN ('draft','pending_approval','approved','superseded')),
  supersedes_snapshot_id  uuid REFERENCES public.material_package_snapshots(id) ON DELETE SET NULL,
  source_bom_count        int,                                    -- 冻结了多少行 BOM
  -- 可追责:谁提交(冻结)、谁批准、各自时间
  submitted_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at            timestamptz,
  approved_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at             timestamptz,
  created_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, version)                                      -- 一订单一版本号唯一
);
CREATE INDEX IF NOT EXISTS idx_mps_order_id ON public.material_package_snapshots(order_id);

-- ── 1b) material_package_snapshot_lines:冻结的逐物料行(不可变)──
CREATE TABLE IF NOT EXISTS public.material_package_snapshot_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id       uuid NOT NULL REFERENCES public.material_package_snapshots(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,   -- 反范式,便于 RLS/查询
  bom_id            uuid REFERENCES public.materials_bom(id) ON DELETE SET NULL,     -- 溯源 live BOM(可空,live 可能被改/删)
  material_name     text NOT NULL,
  material_type     text,
  material_code     text,
  specification     text,
  color             text,
  placement         text,
  qty_per_piece     numeric,        -- 单耗(冻结)
  unit              text,
  loss_rate         numeric,        -- 损耗%(冻结)
  suggested_supplier text,
  sample_status     text,
  remarks           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mpsl_snapshot_id ON public.material_package_snapshot_lines(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_mpsl_order_id    ON public.material_package_snapshot_lines(order_id);

-- ── 2) material_plans:订单级计划头(1:1 订单)──
CREATE TABLE IF NOT EXISTS public.material_plans (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,  -- 1:1
  snapshot_id             uuid REFERENCES public.material_package_snapshots(id) ON DELETE SET NULL,  -- 当前所依据的已批快照
  plan_status             text NOT NULL DEFAULT 'draft'
                          CHECK (plan_status IN ('draft','submitted','active','revising','closed')),
  material_completion_pct numeric,
  mrp_generated_at        timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mp_order_id ON public.material_plans(order_id);

-- ── 3) material_requirements:逐物料需求行 = 跨域脊柱(Explainable MRP 投影)──
CREATE TABLE IF NOT EXISTS public.material_requirements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_plan_id    uuid NOT NULL REFERENCES public.material_plans(id) ON DELETE CASCADE,
  order_id            uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,             -- 反范式
  snapshot_line_id    uuid REFERENCES public.material_package_snapshot_lines(id) ON DELETE SET NULL, -- 来源冻结物料
  material_name       text NOT NULL,
  material_type       text,           -- 沿用 BOM 物料类型(自由值)
  category            text CHECK (category IN
                        ('fabric','trim','packing','print','washing','embroidery','service','other')),  -- 供应链分类(齐料率/齐料点按此分组)
  material_code       text,
  unit                text,
  -- ── Explainable MRP:数量 ──
  gross_requirement   numeric,        -- PO数量 × 单耗
  loss_qty            numeric,        -- × 损耗%
  inventory_deduct    numeric DEFAULT 0,   -- − 现有库存(v1=0)
  reuse_deduct        numeric DEFAULT 0,   -- − 可复用余料(v1=0)
  net_purchase_qty    numeric,        -- = 建议采购量
  confirmed_qty       numeric,        -- 采购确认量(人决策)
  -- ── Explainable MRP:时间分段(required_date 绑定到 required_stage)──
  required_stage      text CHECK (required_stage IN
                        ('cutting','sewing','packing','shipment','sample','other')),  -- 该物料影响哪个阶段
  required_date       date,           -- 需到日(随 required_stage:开裁/车缝/包装/出货 前)
  supplier_lead_days  int,            -- 供应商交期
  order_by_date       date,           -- 最晚下单日 = required_date − lead_days
  timing_status       text,           -- on_time / due_soon / late
  -- ── 解释 + 投影元数据(可重算,仿 runtime_orders)──
  explain_json        jsonb,
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','sourcing','ordered','fulfilled','cancelled')),
  version             int  NOT NULL DEFAULT 1,   -- 乐观并发(重算用)
  last_recomputed_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mr_plan_id     ON public.material_requirements(material_plan_id);
CREATE INDEX IF NOT EXISTS idx_mr_order_id    ON public.material_requirements(order_id);
CREATE INDEX IF NOT EXISTS idx_mr_order_by    ON public.material_requirements(order_by_date);  -- AI Brain 按最晚下单日扫
CREATE INDEX IF NOT EXISTS idx_mr_stage       ON public.material_requirements(required_stage);  -- 按阶段算齐料点

-- ── 4) 现有表加可空链接列(向后兼容,现有流程不读它们)──
ALTER TABLE public.procurement_line_items
  ADD COLUMN IF NOT EXISTS requirement_id uuid REFERENCES public.material_requirements(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pli_requirement_id ON public.procurement_line_items(requirement_id);

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;   -- 配合 Snapshot 修订

-- ── 5) RLS(与订单子表一致;快照行不可变=只读+只插)──
ALTER TABLE public.material_package_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_package_snapshot_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_plans                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_requirements           ENABLE ROW LEVEL SECURITY;

-- snapshots 头:读/插/改状态(approved→superseded)
DROP POLICY IF EXISTS mps_sel ON public.material_package_snapshots;
CREATE POLICY mps_sel ON public.material_package_snapshots FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mps_ins ON public.material_package_snapshots;
CREATE POLICY mps_ins ON public.material_package_snapshots FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mps_upd ON public.material_package_snapshots;
CREATE POLICY mps_upd ON public.material_package_snapshots FOR UPDATE USING (auth.uid() IS NOT NULL);

-- snapshot_lines:不可变 — 只读 + 只插,无 UPDATE/DELETE 策略
DROP POLICY IF EXISTS mpsl_sel ON public.material_package_snapshot_lines;
CREATE POLICY mpsl_sel ON public.material_package_snapshot_lines FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mpsl_ins ON public.material_package_snapshot_lines;
CREATE POLICY mpsl_ins ON public.material_package_snapshot_lines FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- plans / requirements:读/插/改(投影重算 + 采购确认)
DROP POLICY IF EXISTS mp_sel ON public.material_plans;
CREATE POLICY mp_sel ON public.material_plans FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mp_ins ON public.material_plans;
CREATE POLICY mp_ins ON public.material_plans FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mp_upd ON public.material_plans;
CREATE POLICY mp_upd ON public.material_plans FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS mr_sel ON public.material_requirements;
CREATE POLICY mr_sel ON public.material_requirements FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mr_ins ON public.material_requirements;
CREATE POLICY mr_ins ON public.material_requirements FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mr_upd ON public.material_requirements;
CREATE POLICY mr_upd ON public.material_requirements FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ========================================================================
-- 验证 SQL(执行后单独跑,确认建好)
-- ========================================================================
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public'
--   AND table_name IN ('material_package_snapshots','material_package_snapshot_lines','material_plans','material_requirements');  -- 期望 4 行
-- SELECT column_name FROM information_schema.columns WHERE table_name='procurement_line_items' AND column_name='requirement_id';   -- 期望 1 行
-- SELECT column_name FROM information_schema.columns WHERE table_name='materials_bom' AND column_name='version';                  -- 期望 1 行
-- SELECT count(*) FROM material_requirements;  -- 期望 0(B0 不灌数据)

-- ========================================================================
-- 回滚 SQL(B0 纯加法,回滚干净安全 —— 新表空、列可空、无业务代码引用)
-- ========================================================================
-- ALTER TABLE public.procurement_line_items DROP COLUMN IF EXISTS requirement_id;
-- ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS version;
-- DROP TABLE IF EXISTS public.material_requirements;
-- DROP TABLE IF EXISTS public.material_plans;
-- DROP TABLE IF EXISTS public.material_package_snapshot_lines;
-- DROP TABLE IF EXISTS public.material_package_snapshots;
