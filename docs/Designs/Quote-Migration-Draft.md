# Quote Migration — 草案（schema only · DRAFT）

> **Date**: 2026-06-30 · **草案，非定稿。不执行 SQL / 不写应用代码 / 不进 supabase/migrations / 不提交 / 不 push。**
> **遵守**：`Quote-Implementation-Plan` + `Business-Chain-Contract-V1.0` · **Evolution not Rewrite**。
> **拟定稿文件名**（你说"定稿"后才写入）：`supabase/migrations/2026XXXX_quote_header_line_version.sql`。
> **范围**：演进 `quoter_quotes`(加 header 字段) + 新增 `quote_line` + `quote_version_snapshot` + 回填 + 索引 + RLS。
> **不碰**：训练表 / cost·RAG 表 / orders / Customer PO / procurement / finance / UI / actions / PO Compare。**不删列、不改现有列语义。**

---

## 0. 两个关键设计决定（先讲）
1. **status 不动**：`quoter_quotes.status` 有 CHECK `IN ('draft','sent','won','lost','abandoned')`。本 migration **不改 status**（守"不改现有字段语义"）。**"Approved/冻结基线"由 `approved_version` 列 + `quote_version_snapshot.is_approved` 表达**，不靠 status。Phase 2 如需再放宽 CHECK。
2. **冻结基线**：Approved 版写入 `quote_version_snapshot`（不可变，**BEFORE UPDATE 触发器阻止覆盖**）；PO Compare 只读该冻结版。

---

## 1. Migration SQL 草案（DRAFT — 不执行）

```sql
-- ============================================================
-- Quote Header + Line + Version（Evolution not Rewrite）
-- 纯加法：加列/加表/回填/索引/RLS；不删列、不改现有语义、不动训练/cost/orders/PO/finance
-- ============================================================

-- ---------- (1) 演进 quoter_quotes（Header）：只加列 ----------
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS validity_date    date;          -- 报价有效期
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS margin_target    numeric(5,2);  -- 目标毛利%
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS price_floor      numeric(10,3); -- 价格地板(与 PO 审批协同)
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS version          int NOT NULL DEFAULT 1;  -- 当前版本
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS approved_version int;           -- 冻结的 Approved 基线版本号(空=未批)
COMMENT ON COLUMN public.quoter_quotes.approved_version IS
  'Approved 冻结基线版本号；PO Compare 只读该版(quote_version_snapshot)，不读 draft/current。';

-- ---------- (2) 新表 quote_line（多款行；稳定 uuid，供 PO Line M:N 映射）----------
CREATE TABLE IF NOT EXISTS public.quote_line (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- 稳定 id(PO 映射锚)
  quote_id                uuid NOT NULL REFERENCES public.quoter_quotes(id) ON DELETE CASCADE,
  line_no                 int  NOT NULL,
  -- 款式/产品（继承单款字段 + color + 款库引用位）
  style_no                text,
  style_name              text,
  garment_type            text,
  garment_subtype         text,
  color                   text,                                         -- 单款 quoter 无此列,回填 NULL
  product_variant_id      uuid,                                         -- 款库引用位(Phase2 接线,可空)
  quantity                integer,
  size_distribution       jsonb DEFAULT '{}'::jsonb,
  -- 成本（口径继承现有单款字段）
  fabric_type             text,
  fabric_composition      text,
  fabric_width_cm         numeric(6,1),
  fabric_price_per_kg     numeric(8,2),
  fabric_consumption_kg   numeric(8,3),
  fabric_cost_per_piece   numeric(8,2),                                 -- 存值(非 GENERATED,便于回填)
  cmt_factory             text,
  cmt_operations          jsonb,
  cmt_cost_per_piece      numeric(8,2),
  trim_cost_per_piece     numeric(8,2) DEFAULT 0,
  packing_cost_per_piece  numeric(8,2) DEFAULT 0,
  logistics_cost_per_piece numeric(8,2) DEFAULT 0,
  total_cost_per_piece    numeric(8,2),
  margin_rate             numeric(5,2),
  quoted_price_per_piece  numeric(8,2),                                 -- ← quoter_quotes.quote_price_per_piece
  currency                text,
  exchange_rate           numeric(6,3),
  notes                   text,
  status                  text NOT NULL DEFAULT 'draft',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
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
COMMENT ON TABLE public.quote_line IS 'Quote 行(多款)。稳定 id 供 Customer PO Line M:N 映射。继承现有单款字段口径。';

-- ---------- (3) 新表 quote_version_snapshot（冻结版；不可 UPDATE）----------
CREATE TABLE IF NOT EXISTS public.quote_version_snapshot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES public.quoter_quotes(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  snapshot    jsonb NOT NULL,                       -- 冻结的 Header+Lines payload
  reason      text,                                 -- re-quote 原因
  is_approved boolean NOT NULL DEFAULT false,       -- 是否 Approved 基线版
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version)
);
CREATE INDEX IF NOT EXISTS idx_quote_vsnap_quote ON public.quote_version_snapshot(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_vsnap_approved ON public.quote_version_snapshot(quote_id) WHERE is_approved;
ALTER TABLE public.quote_version_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quote_vsnap_select ON public.quote_version_snapshot;
CREATE POLICY quote_vsnap_select ON public.quote_version_snapshot FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS quote_vsnap_insert ON public.quote_version_snapshot;
CREATE POLICY quote_vsnap_insert ON public.quote_version_snapshot FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
-- 无 UPDATE policy + 触发器双保险：冻结不可改
CREATE OR REPLACE FUNCTION public.block_quote_snapshot_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quote_version_snapshot is immutable (frozen); create a new version instead';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_quote_snapshot_immutable ON public.quote_version_snapshot;
CREATE TRIGGER trg_quote_snapshot_immutable
  BEFORE UPDATE ON public.quote_version_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.block_quote_snapshot_update();
COMMENT ON TABLE public.quote_version_snapshot IS 'Approved 冻结版(Header+Lines)。BEFORE UPDATE 触发器禁改;重报=新 version。PO Compare 唯一基线源。';

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
```

---

## 2. 验证 SQL（数据库门禁 — 单独运行）

```sql
-- [1] quoter_quotes 新列存在（期望 5 行）
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='quoter_quotes'
  AND column_name IN ('validity_date','margin_target','price_floor','version','approved_version')
ORDER BY column_name;

-- [2] 新表存在（期望 2 行）
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('quote_line','quote_version_snapshot') ORDER BY table_name;

-- [3] 回填数量 = 现有 quoter_quotes 数量（two counts 应相等）
SELECT (SELECT count(*) FROM public.quoter_quotes) AS quotes,
       (SELECT count(*) FROM public.quote_line)    AS lines;

-- [4] 每个旧 quote 恰好 1 行（期望 0 行异常）
SELECT quote_id, count(*) c FROM public.quote_line GROUP BY quote_id HAVING count(*) <> 1;
--   并确认无 quote 缺行（期望 0）：
SELECT q.id FROM public.quoter_quotes q
  WHERE NOT EXISTS (SELECT 1 FROM public.quote_line l WHERE l.quote_id=q.id);

-- [5] customer_id 存在且 nullable（期望 1 行 uuid/YES）
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='quoter_quotes' AND column_name='customer_id';

-- [6] version snapshot 表存在（[2] 已含；额外验列）
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='quote_version_snapshot' ORDER BY ordinal_position;

-- [7] RLS 启用（期望 quote_line / quote_version_snapshot 均 true）
SELECT c.relname, c.relrowsecurity FROM pg_class c
WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('quote_line','quote_version_snapshot');

-- [8] FK 删除规则 = CASCADE（期望两 FK confdeltype='c'）
SELECT con.conname, t.relname AS child, con.confdeltype
FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
WHERE con.contype='f' AND t.relname IN ('quote_line','quote_version_snapshot');

-- [9] 索引存在（期望 idx_quote_line_quote / idx_quote_vsnap_quote / idx_quote_vsnap_approved）
SELECT indexname FROM pg_indexes WHERE schemaname='public'
  AND tablename IN ('quote_line','quote_version_snapshot') ORDER BY indexname;

-- [10] 旧数据未丢失（quoter_quotes 行数>0 且关键列仍在；GENERATED fabric_cost_per_piece 仍在）
SELECT count(*) AS quote_count FROM public.quoter_quotes;
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='quoter_quotes'
  AND column_name IN ('quote_no','quote_price_per_piece','total_cost_per_piece','status') ORDER BY column_name;

-- [11] 训练表未改动（期望 5 表都在；本 migration 对其零语句=结构性保证）
SELECT table_name FROM information_schema.tables WHERE table_schema='public'
  AND table_name IN ('quoter_fabric_records','quoter_cmt_operations','quoter_cmt_rates','quoter_cmt_training_samples','quoter_training_feedback')
ORDER BY table_name;

-- [12] 冻结不可改（手动验：对 quote_version_snapshot 跑一条 UPDATE 应被触发器拒绝并报错）
-- UPDATE public.quote_version_snapshot SET reason='x' WHERE false;  -- 预期: 抛 'immutable'
```

---

## 3. 回滚 SQL（如需撤销，单独运行）

```sql
DROP TRIGGER IF EXISTS trg_quote_snapshot_immutable ON public.quote_version_snapshot;
DROP FUNCTION IF EXISTS public.block_quote_snapshot_update();
DROP TABLE IF EXISTS public.quote_version_snapshot;
DROP TABLE IF EXISTS public.quote_line;           -- 回填行随表 DROP，quoter_quotes 不受影响
ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS validity_date;
ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS margin_target;
ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS price_floor;
ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS version;
ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS approved_version;
-- customer_id 是 phase0a 的,不在本回滚范围(不删)
```

---

## 4. 风险说明

| 风险 | 级别 | 缓解 |
|---|---|---|
| **临时冗余**：Header 仍存单款字段 + quote_line 第1行镜像 | 中 | Evolution 必经；现有 `/quoter` 页面读 Header 字段**照常工作**；新多行流程写 line；**Header 为现有流程权威，line 为新流程权威**，回填使二者一致。Phase 2 再弃用 Header 单款字段。**本阶段不改 actions/页面，故无双写冲突。** |
| status CHECK 限制 | 低 | **本 migration 不动 status**；Approved 用 approved_version+snapshot 表达；Phase 2 视需放宽 CHECK |
| 回填映射错列 | 中 | 已对照**真实 schema**逐列映射(quote_price_per_piece→quoted_price_per_piece 等)；幂等 NOT EXISTS;门禁[3][4]验数量与"恰好1行" |
| 冻结被绕过 | 低 | BEFORE UPDATE 触发器 + 无 UPDATE policy 双保险;门禁[12]手验 |
| 训练/cost/orders/PO/finance 被波及 | 低 | 本 migration **零语句**触碰它们;门禁[11]验训练表在 |
| customer_id 多为 NULL | 低（预期） | 本 migration **不回填 customer_id**（接线属 app 层,后续）；仅验证列存在 |
| GENERATED 列回填 | 低 | quoter_quotes.fabric_cost_per_piece 是 GENERATED，回填**读其值**写入 quote_line 的普通列，正常 |

---

## 5. 执行顺序

```
1. ALTER quoter_quotes 加 5 列
2. CREATE quote_line + 索引 + RLS
3. CREATE quote_version_snapshot + 不可变触发器 + 索引 + RLS
4. 回填 quote_line（幂等）
5. （单独）跑 §2 验证 SQL 全部 → 数据库门禁 PASS
6. PASS 后才"定稿"进 supabase/migrations + 归档 + 编码
```

---

## 6. 字段 Phase 1 必须 vs Phase 2

| Phase 1（本 migration 必须） | Phase 2（以后） |
|---|---|
| quoter_quotes: validity_date / margin_target / price_floor / version / approved_version | 放宽 status CHECK(加 reviewing/approved/expired) · 弃用 Header 单款字段 |
| quote_line: id/quote_id/line_no/style/color/size/qty/单耗/各成本/total/margin/quoted_price/currency/status | product_variant_id 接款库 · 多 UoM · 损耗/替代料 |
| quote_version_snapshot: 全表 + 不可变触发器 + is_approved | snapshot diff/版本对比视图 |
| 回填(单款→1行) · 索引 · RLS · customer_id 验证 | customer_id 回填/接线(app 层) |

---

> **本文 = Migration 草案。你审 → 说"定稿" → 我写入 `supabase/migrations/2026XXXX_quote_header_line_version.sql` → 你执行 + 跑 §2 门禁 → PASS 归档 → 才编码子阶段 1。** 现不执行 / 不编码 / 不提交 / 不 push。
</content>
