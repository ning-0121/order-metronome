-- ========================================================================
-- QIMO OS P1′ — Procurement Item(采购核料项)(定稿)
-- ========================================================================
-- 采购每天真正工作的对象:同订单内按「物料身份 + 颜色 + 单位」自动归并后的采购确认项。
-- 核料归并 + 采购确认 合一。锚稳定物料身份(consolidation_key),不锚易失 requirement_id。
-- Constitution:02 单一真相(需求量从 material_requirements live 读,不复制)/ 03 生命周期非复制 /
--   04 字段所有权(本表 = 采购层)。ADR-004(待建)。
-- 纯加法、幂等。不动 materials_bom / material_requirements / B1 / procurement_line_items / 现有采购中心。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

CREATE TABLE IF NOT EXISTS public.procurement_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                    uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  item_no                     text,                                  -- PI-{order_no}-{序号}(唯一见下)
  consolidation_key           text NOT NULL,                        -- 归并键(order 内唯一):身份+色+单位

  -- ── 物料身份(归并结果,denorm;master 优先,无则名+规格+类别)──
  material_master_id          uuid REFERENCES public.material_master(id) ON DELETE SET NULL,
  material_name               text,
  specification               text,
  category                    text CHECK (category IN
                              ('fabric','trim','packing','print','washing','embroidery','service','other')),
  color                       text,
  unit                        text,

  -- ── 需求(系统归并;live 可重算,此为展示快照)──
  total_required_qty          numeric,                              -- Σ来源 net_purchase_qty(开发单耗算)
  source_count                int,                                  -- 来源 requirement 条数
  confirmed_source_snapshot   jsonb,                                -- 确认时来源明细快照(审计/判过期)

  -- ── 大货单耗 + 数量模型(采购永不手算,系统出 suggested)──
  development_consumption     numeric,                              -- 开发单耗代表值(业务/系统预填,只读)
  production_consumption      numeric,                              -- 大货单耗(采购填)
  procurement_loss_pct        numeric,                              -- 采购损耗%
  safety_stock_qty            numeric,                              -- 安全库存
  suggested_purchase_qty      numeric,                              -- 系统算 = net×(大货/开发比)×(1+损耗)+安全库存,取整MOQ
  final_purchase_qty          numeric,                              -- 采购确认量(权威,取代 material_requirements.confirmed_qty)

  -- ── A. Supplier ──
  confirmed_supplier_name     text,
  backup_supplier_name        text,
  supplier_contact            text,
  lead_days                   int,
  moq                         numeric,
  purchase_unit               text,

  -- ── C. Price ──
  unit_price                  numeric,
  currency                    text DEFAULT 'CNY',
  tax_rate                    numeric,
  price_inclusive_tax         boolean DEFAULT false,
  quote_date                  date,

  -- ── D. Decision ──
  is_substitute               boolean NOT NULL DEFAULT false,
  substitute_reason           text,
  is_split                    boolean NOT NULL DEFAULT false,
  is_outsourced               boolean NOT NULL DEFAULT false,
  risk_flag                   boolean NOT NULL DEFAULT false,
  risk_note                   text,
  procurement_notes           text,

  -- ── 重确认 / 版本 ──
  needs_reconfirm             boolean NOT NULL DEFAULT false,        -- 来源/总量变化或物料消失 → true
  source_snapshot_version     int,                                  -- 确认时 material_package_snapshots.version
  source_requirement_version  int,                                  -- 确认时 material_requirements.version

  -- ── E. Status(生命周期)──
  status                      text NOT NULL DEFAULT 'draft'
                              CHECK (status IN
                              ('draft','reviewing','confirmed','ordered','partially_received','completed','closed')),
  confirmed_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at                timestamptz,

  created_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- 同订单 + 归并键唯一(防重复核料项)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_order_key  ON public.procurement_items(order_id, consolidation_key);
-- 采购项号唯一(非空)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_item_no    ON public.procurement_items(item_no) WHERE item_no IS NOT NULL;
-- 按订单查
CREATE INDEX        IF NOT EXISTS idx_pi_order     ON public.procurement_items(order_id);
-- 跨订单按状态(未关闭)
CREATE INDEX        IF NOT EXISTS idx_pi_status    ON public.procurement_items(status) WHERE status <> 'closed';
-- 需重新确认
CREATE INDEX        IF NOT EXISTS idx_pi_reconfirm ON public.procurement_items(needs_reconfirm) WHERE needs_reconfirm = true;
-- 按物料主数据(P5 跨订单核料预留)
CREATE INDEX        IF NOT EXISTS idx_pi_master    ON public.procurement_items(material_master_id) WHERE material_master_id IS NOT NULL;

-- ── RLS(登录读/建/改;不开 DELETE,随 order CASCADE)──
ALTER TABLE public.procurement_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pi_sel ON public.procurement_items;
CREATE POLICY pi_sel ON public.procurement_items FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS pi_ins ON public.procurement_items;
CREATE POLICY pi_ins ON public.procurement_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS pi_upd ON public.procurement_items;
CREATE POLICY pi_upd ON public.procurement_items FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ========================================================================
-- 验证 SQL(执行后单独跑)
-- ========================================================================
-- 期望 1 行:表存在
-- SELECT to_regclass('public.procurement_items') IS NOT NULL AS table_exists;
--
-- 期望 8 行:核心字段都在
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='procurement_items'
--    AND column_name IN ('consolidation_key','development_consumption','production_consumption',
--                        'suggested_purchase_qty','final_purchase_qty','needs_reconfirm','status','confirmed_source_snapshot');
--
-- 期望 2 个关键 FK + 删除规则:order_id→orders(confdeltype='c')、material_master_id→material_master(confdeltype='n')
-- SELECT conname, confrelid::regclass AS ref, confdeltype FROM pg_constraint
--  WHERE conrelid='public.procurement_items'::regclass AND contype='f';
--
-- 期望:order_id+consolidation_key 唯一约束存在
-- SELECT indexname FROM pg_indexes WHERE tablename='procurement_items' AND indexname='uq_pi_order_key';
--
-- 期望 0 行(新表) / RLS=true / 6 个自建索引 + 主键
-- SELECT count(*) FROM procurement_items;
-- SELECT relrowsecurity FROM pg_class WHERE relname='procurement_items';
-- SELECT indexname FROM pg_indexes WHERE tablename='procurement_items' ORDER BY indexname;

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净)
-- ========================================================================
-- DROP TABLE IF EXISTS public.procurement_items;
