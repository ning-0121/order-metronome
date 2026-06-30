-- ============================================================
-- Quote Header + Line + Version（Evolution not Rewrite）
-- Supabase: scrtebexbxablybqpdla（QIMO）
-- Date: 2026-06-30
-- 设计依据: docs/Designs/Quote-Implementation-Plan.md + Quote-Migration-Draft.md
--           + Business-Chain-Contract-V1.0
-- ------------------------------------------------------------
-- 性质: 纯加法。只加列/加表/回填/索引/RLS/触发器。
--   ❌ 不删列 · ❌ 不改现有列语义 · ❌ 不改 quoter_quotes.status CHECK
--   ❌ 不碰 训练表 / RAG·cost 表 / orders / Customer PO / procurement / finance / UI / actions
-- 关键: ① status 不动；Approved 用 approved_version + snapshot.is_approved 表达
--       ② quote_version_snapshot 冻结(BEFORE UPDATE 触发器 + 无 UPDATE policy)
--       ③ 回填幂等(NOT EXISTS)，每条旧 quote 恰好 1 line
--       ④ customer_id 已由 phase0a 加入，本文件不新增/不回滚，仅由验证 SQL 检查
-- ============================================================

-- ---------- (1) 演进 quoter_quotes（Header）：只加列 ----------
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS validity_date    date;          -- 报价有效期
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS margin_target    numeric(5,2);  -- 目标毛利%
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS price_floor      numeric(10,3); -- 价格地板(与 PO 审批协同)
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS version          int NOT NULL DEFAULT 1;  -- 当前版本
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS approved_version int;           -- 冻结 Approved 基线版本号(空=未批)
COMMENT ON COLUMN public.quoter_quotes.approved_version IS
  'Approved 冻结基线版本号；Customer PO Compare 只读该版(quote_version_snapshot)，不读 draft/current。';

-- ---------- (2) 新表 quote_line（多款行；稳定 uuid，供 PO Line M:N 映射）----------
CREATE TABLE IF NOT EXISTS public.quote_line (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 稳定 id(PO 映射锚)
  quote_id                 uuid NOT NULL REFERENCES public.quoter_quotes(id) ON DELETE CASCADE,
  line_no                  int  NOT NULL,
  style_no                 text,
  style_name               text,
  garment_type             text,
  garment_subtype          text,
  color                    text,                       -- 单款 quoter 无此列,回填 NULL
  product_variant_id       uuid,                       -- 款库引用位(Phase2 接线,可空)
  quantity                 integer,
  size_distribution        jsonb DEFAULT '{}'::jsonb,
  fabric_type              text,
  fabric_composition       text,
  fabric_width_cm          numeric(6,1),
  fabric_price_per_kg      numeric(8,2),
  fabric_consumption_kg    numeric(8,3),
  fabric_cost_per_piece    numeric(8,2),               -- 存值(非 GENERATED,便于回填)
  cmt_factory              text,
  cmt_operations           jsonb,
  cmt_cost_per_piece       numeric(8,2),
  trim_cost_per_piece      numeric(8,2) DEFAULT 0,
  packing_cost_per_piece   numeric(8,2) DEFAULT 0,
  logistics_cost_per_piece numeric(8,2) DEFAULT 0,
  total_cost_per_piece     numeric(8,2),
  margin_rate              numeric(5,2),
  quoted_price_per_piece   numeric(8,2),               -- ← quoter_quotes.quote_price_per_piece
  currency                 text,
  exchange_rate            numeric(6,3),
  notes                    text,
  status                   text NOT NULL DEFAULT 'draft',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_quote_line_quote ON public.quote_line(quote_id);
ALTER TABLE public.quote_line ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quote_line_select ON public.quote_line;
CREATE POLICY quote_line_select ON public.quote_line FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS quote_line_insert ON public.quote_line;
CREATE POLICY quote_line_insert ON public.quote_line FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS quote_line_update ON public.quote_line;
CREATE POLICY quote_line_update ON public.quote_line FOR UPDATE USING (auth.uid() IS NOT NULL);
COMMENT ON TABLE public.quote_line IS
  'Quote 行(多款)。稳定 id 供 Customer PO Line M:N 映射。继承现有单款字段口径。';

-- ---------- (3) 新表 quote_version_snapshot（冻结版；不可 UPDATE）----------
CREATE TABLE IF NOT EXISTS public.quote_version_snapshot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES public.quoter_quotes(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  snapshot    jsonb NOT NULL,                     -- 冻结的 Header+Lines payload
  reason      text,                               -- re-quote 原因
  is_approved boolean NOT NULL DEFAULT false,     -- 是否 Approved 基线版
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version)
);
CREATE INDEX IF NOT EXISTS idx_quote_vsnap_quote    ON public.quote_version_snapshot(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_vsnap_approved ON public.quote_version_snapshot(quote_id) WHERE is_approved;
ALTER TABLE public.quote_version_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quote_vsnap_select ON public.quote_version_snapshot;
CREATE POLICY quote_vsnap_select ON public.quote_version_snapshot FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS quote_vsnap_insert ON public.quote_version_snapshot;
CREATE POLICY quote_vsnap_insert ON public.quote_version_snapshot FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
-- 冻结: 无 UPDATE policy + BEFORE UPDATE 触发器双保险
CREATE OR REPLACE FUNCTION public.block_quote_snapshot_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quote_version_snapshot is immutable (frozen); create a new version instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_quote_snapshot_immutable ON public.quote_version_snapshot;
CREATE TRIGGER trg_quote_snapshot_immutable
  BEFORE UPDATE ON public.quote_version_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.block_quote_snapshot_update();
COMMENT ON TABLE public.quote_version_snapshot IS
  'Approved 冻结版(Header+Lines)。BEFORE UPDATE 触发器禁改;重报=新 version。Customer PO Compare 唯一基线源。';

-- ---------- (4) 回填：每条 quoter_quotes → 1 条 quote_line（幂等）----------
INSERT INTO public.quote_line (
  quote_id, line_no, style_no, style_name, garment_type, garment_subtype,
  quantity, size_distribution,
  fabric_type, fabric_composition, fabric_width_cm, fabric_price_per_kg, fabric_consumption_kg, fabric_cost_per_piece,
  cmt_factory, cmt_operations, cmt_cost_per_piece,
  trim_cost_per_piece, packing_cost_per_piece, logistics_cost_per_piece,
  margin_rate, total_cost_per_piece, quoted_price_per_piece, currency, exchange_rate, status
)
SELECT
  q.id, 1, q.style_no, q.style_name, q.garment_type, q.garment_subtype,
  q.quantity, q.size_distribution,
  q.fabric_type, q.fabric_composition, q.fabric_width_cm, q.fabric_price_per_kg, q.fabric_consumption_kg, q.fabric_cost_per_piece,
  q.cmt_factory, q.cmt_operations, q.cmt_cost_per_piece,
  q.trim_cost_per_piece, q.packing_cost_per_piece, q.logistics_cost_per_piece,
  q.margin_rate, q.total_cost_per_piece, q.quote_price_per_piece, q.currency, q.exchange_rate, 'draft'
FROM public.quoter_quotes q
WHERE NOT EXISTS (SELECT 1 FROM public.quote_line l WHERE l.quote_id = q.id);  -- 幂等:已回填不重复

-- ============================================================
-- 验证 SQL（数据库门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] quoter_quotes 新列存在（期望 5 行）
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='quoter_quotes'
--   AND column_name IN ('validity_date','margin_target','price_floor','version','approved_version')
-- ORDER BY column_name;
--
-- [2] 新表存在（期望 2 行）
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' AND table_name IN ('quote_line','quote_version_snapshot') ORDER BY table_name;
--
-- [3] 回填数量 = 现有 quoter_quotes 数量（quotes 应 = lines）
-- SELECT (SELECT count(*) FROM public.quoter_quotes) AS quotes, (SELECT count(*) FROM public.quote_line) AS lines;
--
-- [4] 每个旧 quote 恰好 1 行（两条均期望 0 行）
-- SELECT quote_id, count(*) c FROM public.quote_line GROUP BY quote_id HAVING count(*) <> 1;
-- SELECT q.id FROM public.quoter_quotes q WHERE NOT EXISTS (SELECT 1 FROM public.quote_line l WHERE l.quote_id=q.id);
--
-- [5] customer_id 存在且 nullable（期望 1 行 uuid/YES）
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='quoter_quotes' AND column_name='customer_id';
--
-- [6] version snapshot 表列（验列）
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='quote_version_snapshot' ORDER BY ordinal_position;
--
-- [7] RLS 启用（quote_line / quote_version_snapshot 均 true）
-- SELECT c.relname, c.relrowsecurity FROM pg_class c
-- WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('quote_line','quote_version_snapshot');
--
-- [8] FK 删除规则 = CASCADE（两 FK confdeltype='c'）
-- SELECT con.conname, t.relname AS child, con.confdeltype FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE con.contype='f' AND t.relname IN ('quote_line','quote_version_snapshot');
--
-- [9] 索引存在（idx_quote_line_quote / idx_quote_vsnap_quote / idx_quote_vsnap_approved）
-- SELECT indexname FROM pg_indexes WHERE schemaname='public'
--   AND tablename IN ('quote_line','quote_version_snapshot') ORDER BY indexname;
--
-- [10] 旧数据未丢失（quoter_quotes 行数>0；关键列仍在）
-- SELECT count(*) AS quote_count FROM public.quoter_quotes;
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='quoter_quotes'
--   AND column_name IN ('quote_no','quote_price_per_piece','total_cost_per_piece','status') ORDER BY column_name;
--
-- [11] 训练表未改动（5 表都在；本 migration 对其零语句）
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public'
--   AND table_name IN ('quoter_fabric_records','quoter_cmt_operations','quoter_cmt_rates','quoter_cmt_training_samples','quoter_training_feedback')
-- ORDER BY table_name;
--
-- [12] 冻结不可改（手动验：对 snapshot 跑 UPDATE 应被触发器拒绝报 'immutable'）
-- 先插一行测试，再 UPDATE 它，预期抛异常；测完删除测试行：
-- INSERT INTO public.quote_version_snapshot (quote_id, version, snapshot)
--   SELECT id, 999, '{}'::jsonb FROM public.quoter_quotes LIMIT 1;
-- UPDATE public.quote_version_snapshot SET reason='x' WHERE version=999;  -- 预期: ERROR immutable
-- DELETE FROM public.quote_version_snapshot WHERE version=999;
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行；本文件正常执行不含回滚）
-- ------------------------------------------------------------
-- DROP TRIGGER IF EXISTS trg_quote_snapshot_immutable ON public.quote_version_snapshot;
-- DROP FUNCTION IF EXISTS public.block_quote_snapshot_update();
-- DROP TABLE IF EXISTS public.quote_version_snapshot;
-- DROP TABLE IF EXISTS public.quote_line;          -- 回填行随表 DROP；quoter_quotes 不受影响
-- ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS validity_date;
-- ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS margin_target;
-- ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS price_floor;
-- ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS version;
-- ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS approved_version;
-- 注: customer_id 属 phase0a，不在本回滚范围（不删）。
-- ============================================================
