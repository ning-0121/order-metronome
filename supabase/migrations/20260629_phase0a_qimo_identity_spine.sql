-- ============================================================
-- Phase 0a · QIMO OS · Identity Spine
-- Supabase: scrtebexbxablybqpdla（QIMO，Enterprise Host）
-- Date: 2026-06-29
-- 设计依据: docs/integration/05-Phase-0-Integration-Spine-Design.md §B.1
--           docs/integration/06-phase-0a-migration-drafts.md §1
-- ------------------------------------------------------------
-- 范围: 仅 QIMO OS 5 列（identity spine）。
-- 性质: 纯加法 · 可空 · 幂等(IF NOT EXISTS) · 无跨库 FK ·
--       不改任何现有列语义 · 不动 RLS(可空新列被现有策略覆盖) ·
--       一键回滚 · 不影响线上。
-- 顺序: 三库分开推进，本文件 = 第 1 个(QIMO)。PASS 后再做 finance。
-- ============================================================

-- ---- (1) 本库引用列（同 Supabase；业务关系 id）----
--      0a 只加可空列；FK 约束(REFERENCES)留待 EA V1.1 接线时再加，
--      保持 0a 纯加列、零约束/锁风险。
ALTER TABLE public.quoter_quotes ADD COLUMN IF NOT EXISTS customer_id     uuid;  -- 将接 public.customers.id
ALTER TABLE public.orders        ADD COLUMN IF NOT EXISTS origin_quote_id uuid;  -- 将接 public.quoter_quotes.id

-- ---- (2) 跨库 external trace id（仅审计/溯源；绝不 REFERENCES）----
--      红线: 只是外部溯源指针，不是业务关系 id。
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS source_araos_company_id uuid;  -- ARAOS companies.id
ALTER TABLE public.orders    ADD COLUMN IF NOT EXISTS source_araos_order_id   uuid;  -- ARAOS orders.id
ALTER TABLE public.orders    ADD COLUMN IF NOT EXISTS source_araos_deal_id    uuid;  -- ARAOS deals.id

-- ---- (3) 列注释（把红线写进 schema）----
COMMENT ON COLUMN public.quoter_quotes.customer_id IS
  'Phase0a identity spine: 本库引用 public.customers.id（业务关系 id）。FK 约束 EA V1.1 接线时再加。';
COMMENT ON COLUMN public.orders.origin_quote_id IS
  'Phase0a identity spine: 本库引用 public.quoter_quotes.id（订单继承自报价，业务关系 id）。FK 约束 EA V1.1 再加。';

COMMENT ON COLUMN public.customers.source_araos_company_id IS
  'Phase0a EXTERNAL TRACE ONLY: ARAOS companies.id（跨库溯源指针，非业务关系 id）。'
  '禁止用于业务判断 / 权限判断 / 状态判断 / 金额勾稽 / 查询归并。仅限审计追溯与人工核对。绝不 REFERENCES 跨库。';
COMMENT ON COLUMN public.orders.source_araos_order_id IS
  'Phase0a EXTERNAL TRACE ONLY: ARAOS orders.id（跨库溯源指针，非业务关系 id）。'
  '禁止用于业务判断 / 权限判断 / 状态判断。仅限审计追溯与人工核对。绝不 REFERENCES 跨库。';
COMMENT ON COLUMN public.orders.source_araos_deal_id IS
  'Phase0a EXTERNAL TRACE ONLY: ARAOS deals.id（跨库溯源指针，非业务关系 id）。'
  '禁止用于业务判断 / 权限判断 / 状态判断。仅限审计追溯与人工核对。绝不 REFERENCES 跨库。';

-- 注: 可选部分索引(WHERE col IS NOT NULL)不在本文件，按"只含 5 列"约束，
--     留到 Phase 0e 回填时按需添加。

-- ============================================================
-- 验证 SQL（数据库门禁 — 在 Supabase SQL Editor 单独运行，应返回 5 行）
-- 期望: 5 行；全部 data_type=uuid, is_nullable=YES
-- ------------------------------------------------------------
-- SELECT table_name, column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND (
--   (table_name='quoter_quotes' AND column_name='customer_id') OR
--   (table_name='orders'        AND column_name IN ('origin_quote_id','source_araos_order_id','source_araos_deal_id')) OR
--   (table_name='customers'     AND column_name='source_araos_company_id')
-- )
-- ORDER BY table_name, column_name;
--
-- 验证列注释已写入（应返回 5 行 description）:
-- SELECT c.table_name, c.column_name, pgd.description
-- FROM information_schema.columns c
-- JOIN pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name
-- JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
-- WHERE c.table_schema='public' AND (
--   (c.table_name='quoter_quotes' AND c.column_name='customer_id') OR
--   (c.table_name='orders'        AND c.column_name IN ('origin_quote_id','source_araos_order_id','source_araos_deal_id')) OR
--   (c.table_name='customers'     AND c.column_name='source_araos_company_id')
-- );
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行；本文件正常执行不含回滚）
-- ------------------------------------------------------------
-- ALTER TABLE public.quoter_quotes DROP COLUMN IF EXISTS customer_id;
-- ALTER TABLE public.orders        DROP COLUMN IF EXISTS origin_quote_id;
-- ALTER TABLE public.customers     DROP COLUMN IF EXISTS source_araos_company_id;
-- ALTER TABLE public.orders        DROP COLUMN IF EXISTS source_araos_order_id;
-- ALTER TABLE public.orders        DROP COLUMN IF EXISTS source_araos_deal_id;
-- ============================================================
