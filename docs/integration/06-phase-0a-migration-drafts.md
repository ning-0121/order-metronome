# Phase 0a — Identity Spine Migration Drafts（三仓库）

> **Status**: 🟡 **DRAFT — 不执行 / 不进 migrations 目录 / 不提交 / 不 push。** 仅供审阅。
> **Date**: 2026-06-29 · 承接 `05-Phase-0-Integration-Spine-Design.md` §B（0a 定稿列集，共 15 列）。
> **范围**: 仅 0a 身份字段。纯加法（`ADD COLUMN IF NOT EXISTS`，可空）+ 列注释 + 可选部分索引 + 验证 SQL + 回滚。
> **三库独立 Supabase**：QIMO `scrtebexbxablybqpdla` · finance `qpoboelobqnfbytugzkw` · ARAOS `hpdcqjfwmcbdlgywhjog`。**每库各自执行各自那段，互不依赖**。
> **共同约束**：均为可空 uuid（`qimo_ack_at` 为 timestamptz）；**无任何跨库 `REFERENCES`**；不改现有列语义；不动 RLS（可空新列默认被现有策略覆盖，无需改策略）；回滚 = `DROP COLUMN`。
> **执行纪律（批准后）**：先过**数据库门禁**（逐条验证 SQL 真实返回 → PASS 才算数）→ 单独 commit 归档 → 各库 build/check → diff 审 → 批了才 push。QIMO 侧仅在 **CloudDocs 权威副本** 操作。

---

## 1. QIMO OS（5 列）

> 建议文件：`supabase/migrations/2026MMDD_phase0a_identity_spine.sql`（日期执行时定）。
> 2 本库引用列（`customer_id` / `origin_quote_id`，**0a 只加列，FK 约束延后**）+ 3 跨库 trace（`source_araos_*`，**只溯源不参与业务**）。

```sql
-- ============================================================
-- Phase 0a · QIMO OS · Identity Spine（DRAFT — DO NOT RUN）
-- Supabase: scrtebexbxablybqpdla
-- 纯加法 · 可空 · 幂等 · 无跨库 FK · 不改现有列语义 · 不动 RLS
-- ============================================================

-- ---- 本库引用列（同 Supabase；0a 先加可空列，FK 约束留待 EA V1.1 接线）----
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS customer_id     uuid;  -- 将接 public.customers.id
ALTER TABLE public.orders        ADD COLUMN IF NOT EXISTS origin_quote_id uuid;  -- 将接 public.quoter_quotes.id

-- ---- 跨库 external trace id（仅审计/溯源；绝不 REFERENCES；不得作业务判断依据）----
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS source_araos_company_id uuid;  -- ARAOS companies.id
ALTER TABLE public.orders    ADD COLUMN IF NOT EXISTS source_araos_order_id   uuid;  -- ARAOS orders.id
ALTER TABLE public.orders    ADD COLUMN IF NOT EXISTS source_araos_deal_id    uuid;  -- ARAOS deals.id

-- ---- 列注释（把红线写进 schema）----
COMMENT ON COLUMN public.quoter_quotes.customer_id IS 'Phase0a: 本库引用 customers.id（业务关系 id）。FK 约束 EA V1.1 再加。';
COMMENT ON COLUMN public.orders.origin_quote_id    IS 'Phase0a: 本库引用 quoter_quotes.id（订单继承自报价）。FK 约束 EA V1.1 再加。';
COMMENT ON COLUMN public.customers.source_araos_company_id IS 'Phase0a: EXTERNAL TRACE ONLY（ARAOS companies.id）。禁止作业务/权限/勾稽/状态判断依据。仅审计与人工核对。';
COMMENT ON COLUMN public.orders.source_araos_order_id      IS 'Phase0a: EXTERNAL TRACE ONLY（ARAOS orders.id）。禁止作业务判断依据。';
COMMENT ON COLUMN public.orders.source_araos_deal_id       IS 'Phase0a: EXTERNAL TRACE ONLY（ARAOS deals.id）。禁止作业务判断依据。';

-- ---- 可选部分索引（仅 NOT NULL；服务回填/反查；低成本）----
CREATE INDEX IF NOT EXISTS idx_quoter_quotes_customer_id   ON public.quoter_quotes(customer_id)     WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_origin_quote_id      ON public.orders(origin_quote_id)        WHERE origin_quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_src_araos_order_id   ON public.orders(source_araos_order_id)  WHERE source_araos_order_id IS NOT NULL;
```

**验证 SQL（数据库门禁 — 应返回 5 行）**
```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND (
  (table_name='quoter_quotes' AND column_name='customer_id') OR
  (table_name='orders'        AND column_name IN ('origin_quote_id','source_araos_order_id','source_araos_deal_id')) OR
  (table_name='customers'     AND column_name='source_araos_company_id')
)
ORDER BY table_name, column_name;
-- 期望：5 行，全部 data_type=uuid, is_nullable=YES
```

**回滚**
```sql
ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS customer_id;
ALTER TABLE public.orders        DROP COLUMN IF EXISTS origin_quote_id;
ALTER TABLE public.customers     DROP COLUMN IF EXISTS source_araos_company_id;
ALTER TABLE public.orders        DROP COLUMN IF EXISTS source_araos_order_id;
ALTER TABLE public.orders        DROP COLUMN IF EXISTS source_araos_deal_id;
-- 索引随列自动消失；如需显式：DROP INDEX IF EXISTS idx_quoter_quotes_customer_id; ...
```

---

## 2. finance-system（4 列）

> 建议文件：`migrations/2026MMDD_phase0a_qimo_identity_spine.sql`（finance 用 `migrations/` 目录）。
> `synced_orders.id` 已 = QIMO orders.id（不新增）；本段只补客户/预算/报价的企业 id 引用。

```sql
-- ============================================================
-- Phase 0a · finance-system · QIMO Identity Spine（DRAFT — DO NOT RUN）
-- Supabase: qpoboelobqnfbytugzkw
-- 纯加法 · 可空 · 幂等 · 无跨库 FK · 不改现有列语义 · 不动 RLS
-- 注意：本段只加 id 列，不改 customers 匹配/budget 逻辑/UI（那是 Finance 重构，出 Phase 0）
-- ============================================================

ALTER TABLE public.customers     ADD COLUMN IF NOT EXISTS qimo_customer_id uuid;  -- 引用 QIMO customers.id（停 ilike 自建，逻辑改造在后续 Phase）
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;  -- 引用 QIMO orders.id（停 notes/order_no 猜）
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;  -- 引用 QIMO quoter_quotes.id（forecast 来源）
ALTER TABLE public.synced_orders ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;  -- 内联报价对应的 QIMO quoter_quotes.id（审计）

COMMENT ON COLUMN public.customers.qimo_customer_id     IS 'Phase0a: 企业 Customer 身份（QIMO customers.id）。回填后逐步替代 name ilike 匹配。';
COMMENT ON COLUMN public.budget_orders.qimo_order_id    IS 'Phase0a: 企业 Order 身份（QIMO orders.id）。替代 notes/order_no 模糊归属。';
COMMENT ON COLUMN public.budget_orders.qimo_quote_id    IS 'Phase0a: 企业 Quote 身份（QIMO quoter_quotes.id）。_cost_breakdown forecast 来源。';
COMMENT ON COLUMN public.synced_orders.qimo_quote_id    IS 'Phase0a: 内联 quotation 对应的 QIMO quoter_quotes.id（审计溯源）。';

-- ---- 可选部分索引 ----
CREATE INDEX IF NOT EXISTS idx_fin_customers_qimo_id     ON public.customers(qimo_customer_id)  WHERE qimo_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_budget_qimo_order_id  ON public.budget_orders(qimo_order_id) WHERE qimo_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_budget_qimo_quote_id  ON public.budget_orders(qimo_quote_id) WHERE qimo_quote_id IS NOT NULL;
```

**验证 SQL（应返回 4 行）**
```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND (
  (table_name='customers'     AND column_name='qimo_customer_id') OR
  (table_name='budget_orders' AND column_name IN ('qimo_order_id','qimo_quote_id')) OR
  (table_name='synced_orders' AND column_name='qimo_quote_id')
)
ORDER BY table_name, column_name;
-- 期望：4 行，data_type=uuid, is_nullable=YES
```

**回滚**
```sql
ALTER TABLE public.customers     DROP COLUMN IF EXISTS qimo_customer_id;
ALTER TABLE public.budget_orders DROP COLUMN IF EXISTS qimo_order_id;
ALTER TABLE public.budget_orders DROP COLUMN IF EXISTS qimo_quote_id;
ALTER TABLE public.synced_orders DROP COLUMN IF EXISTS qimo_quote_id;
```

---

## 3. clients-Hunters-OS / araos（6 列）

> 建议文件：`supabase/migrations/2026MMDD_phase0a_qimo_identity_spine.sql`（与现有 001/003 同目录）。
> ⚠️ ARAOS 现网 RLS 仍是 `USING(true)` 占位（审计 §1.3）——本段**不动 RLS**，仅加列。

```sql
-- ============================================================
-- Phase 0a · araos · QIMO Identity Spine（DRAFT — DO NOT RUN）
-- Supabase: hpdcqjfwmcbdlgywhjog
-- 纯加法 · 可空 · 幂等 · 无跨库 FK · 不改现有列语义 · 不动 RLS
-- ============================================================

ALTER TABLE public.companies          ADD COLUMN IF NOT EXISTS qimo_customer_id uuid;        -- 赢单晋升后 QIMO customers.id 回填
ALTER TABLE public.deals              ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;        -- 售前策略 → QIMO quoter_quotes.id
ALTER TABLE public.orders             ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;        -- 薄订单 → QIMO orders.id 指针
ALTER TABLE public.samples            ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;        -- 打样 → QIMO orders.id 关联（可空）
ALTER TABLE public.metronome_handoffs ADD COLUMN IF NOT EXISTS qimo_entity_id   uuid;        -- QIMO 回执 id（推过去变成了谁）
ALTER TABLE public.metronome_handoffs ADD COLUMN IF NOT EXISTS qimo_ack_at      timestamptz; -- QIMO 确认回执时间

COMMENT ON COLUMN public.companies.qimo_customer_id          IS 'Phase0a: 赢单晋升后 QIMO customers.id（企业 Customer 身份）。';
COMMENT ON COLUMN public.deals.qimo_quote_id                 IS 'Phase0a: 对应 QIMO 正式报价 quoter_quotes.id。';
COMMENT ON COLUMN public.orders.qimo_order_id               IS 'Phase0a: 对应 QIMO orders.id；本表订单降级为 handoff 指针（真相在 QIMO）。';
COMMENT ON COLUMN public.samples.qimo_order_id              IS 'Phase0a: 打样关联的 QIMO orders.id（可空）。';
COMMENT ON COLUMN public.metronome_handoffs.qimo_entity_id   IS 'Phase0a: QIMO handoff 回执 id（对应创建/匹配的 QIMO 对象）。';
COMMENT ON COLUMN public.metronome_handoffs.qimo_ack_at      IS 'Phase0a: QIMO 接收并确认 handoff 的时间戳。';

-- ---- 可选部分索引 ----
CREATE INDEX IF NOT EXISTS idx_ar_companies_qimo_customer ON public.companies(qimo_customer_id) WHERE qimo_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_orders_qimo_order       ON public.orders(qimo_order_id)       WHERE qimo_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_handoffs_qimo_entity    ON public.metronome_handoffs(qimo_entity_id) WHERE qimo_entity_id IS NOT NULL;
```

**验证 SQL（应返回 6 行）**
```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND (
  (table_name='companies'          AND column_name='qimo_customer_id') OR
  (table_name='deals'              AND column_name='qimo_quote_id') OR
  (table_name='orders'             AND column_name='qimo_order_id') OR
  (table_name='samples'            AND column_name='qimo_order_id') OR
  (table_name='metronome_handoffs' AND column_name IN ('qimo_entity_id','qimo_ack_at'))
)
ORDER BY table_name, column_name;
-- 期望：6 行；5 个 uuid + 1 个 timestamptz（qimo_ack_at）；全部 is_nullable=YES
```

**回滚**
```sql
ALTER TABLE public.companies          DROP COLUMN IF EXISTS qimo_customer_id;
ALTER TABLE public.deals              DROP COLUMN IF EXISTS qimo_quote_id;
ALTER TABLE public.orders             DROP COLUMN IF EXISTS qimo_order_id;
ALTER TABLE public.samples            DROP COLUMN IF EXISTS qimo_order_id;
ALTER TABLE public.metronome_handoffs DROP COLUMN IF EXISTS qimo_entity_id;
ALTER TABLE public.metronome_handoffs DROP COLUMN IF EXISTS qimo_ack_at;
```

---

## 4. 三库合计核对（15 列）
| 库 | 列数 | 列 |
|---|---|---|
| QIMO OS | 5 | quoter_quotes.customer_id · orders.origin_quote_id · customers.source_araos_company_id · orders.source_araos_order_id · orders.source_araos_deal_id |
| finance-system | 4 | customers.qimo_customer_id · budget_orders.qimo_order_id · budget_orders.qimo_quote_id · synced_orders.qimo_quote_id |
| araos | 6 | companies.qimo_customer_id · deals.qimo_quote_id · orders.qimo_order_id · samples.qimo_order_id · metronome_handoffs.qimo_entity_id · metronome_handoffs.qimo_ack_at |

**全部满足**：可空 · 纯加法 · 幂等 · 无跨库 FK · 不改现有列语义 · 不动 RLS · 可一键回滚 · 不影响线上。

> **下一步（待你逐库批准）**：把对应段落落入各库 migrations 目录 → 各自走数据库门禁（验证 SQL 必须真实返回期望行数 → PASS）→ 单独 commit 归档 → build/check → diff 审 → 批了才 push。**本轮仍：不执行、不提交、不 push。**
</content>
