-- ============================================================
-- Customer PO — Phase C（Quote Snapshot 绑定层 · 纯绑定容器）
-- Supabase: scrtebexbxablybqpdla（QIMO）
-- Date: 2026-07-01
-- 设计依据: Business-Chain-Contract-V1.0 §一(Quote→PO=REFERENCE) + PO Phase 1 Implementation Plan
-- ------------------------------------------------------------
-- 性质: 纯加法。只加 1 张新表 + 2 索引 + RLS。
--   ❌ 无 price / cost / margin / line 列（Phase 1 = 纯绑定容器，不拥有任何业务值）
--   ❌ 不碰 quoter_quotes / quote_line / quote_version_snapshot / orders / 任何现有表
-- 核心: 复合 FK (quote_id, quote_snapshot_version) → quote_version_snapshot(quote_id, version)
--       DB 级保证 PO 只能锚定"已存在的冻结快照版"，永不绑 live quote / 不存在的版本。
--       （quote_version_snapshot 已有 UNIQUE(quote_id, version)，故复合 FK 合法。）
-- ============================================================

CREATE TABLE IF NOT EXISTS public.customer_po (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number              text NOT NULL,                                    -- 客户自己的 PO 号
  customer_id            uuid NOT NULL REFERENCES public.customers(id),    -- 客户引用（单一真相）
  quote_id               uuid NOT NULL REFERENCES public.quoter_quotes(id),
  quote_snapshot_version int  NOT NULL,                                    -- 绑定的冻结版号（= approved_version）
  status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','confirmed','converted','cancelled')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- ===== CRITICAL: SNAPSHOT BINDING CONSTRAINT =====
  -- PO 只能绑定真实存在的冻结快照版；不可能绑 live quote / 不存在版本。
  CONSTRAINT customer_po_snapshot_fk
    FOREIGN KEY (quote_id, quote_snapshot_version)
    REFERENCES public.quote_version_snapshot(quote_id, version)
);

CREATE INDEX IF NOT EXISTS idx_customer_po_quote    ON public.customer_po(quote_id, quote_snapshot_version);
CREATE INDEX IF NOT EXISTS idx_customer_po_customer ON public.customer_po(customer_id);

ALTER TABLE public.customer_po ENABLE ROW LEVEL SECURITY;
-- RLS：登录即可读写（与 quote_line / quote_version_snapshot 同口径，无复杂角色）。
-- ⚠️ 用 auth.uid() IS NOT NULL 而非 USING(true)：与全库 RLS 基线一致，避免匿名可写的安全洞。
DROP POLICY IF EXISTS customer_po_select ON public.customer_po;
CREATE POLICY customer_po_select ON public.customer_po FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS customer_po_insert ON public.customer_po;
CREATE POLICY customer_po_insert ON public.customer_po FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS customer_po_update ON public.customer_po;
CREATE POLICY customer_po_update ON public.customer_po FOR UPDATE USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.customer_po IS
  'Customer PO Phase 1：纯绑定容器。只存 quote_id + quote_snapshot_version 引用冻结快照，无任何价/成本/毛利/行。复合 FK 保证只能绑真实冻结版。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- 逐条真实返回并核对期望，全 PASS 才允许进入 D Step / commit。
-- ------------------------------------------------------------
-- [1] 表存在（期望 1 行）
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' AND table_name='customer_po';
--
-- [2] 列集合正确（期望恰好这 8 列，且无 price/cost/margin/line）
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='customer_po' ORDER BY ordinal_position;
--   期望: id, po_number, customer_id, quote_id, quote_snapshot_version, status, created_at, updated_at
--
-- [3] 无业务字段污染（期望 0 行）
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='customer_po'
--   AND (column_name ILIKE '%price%' OR column_name ILIKE '%cost%'
--        OR column_name ILIKE '%margin%' OR column_name ILIKE '%line%');
--
-- [4] status CHECK 存在（期望含 draft/confirmed/converted/cancelled）
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='customer_po' AND con.contype='c';
--
-- [5] 复合 FK → quote_version_snapshot 存在（期望 1 行 customer_po_snapshot_fk）
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='customer_po' AND con.contype='f'
--   AND pg_get_constraintdef(con.oid) ILIKE '%quote_version_snapshot%';
--
-- [6] 全部 FK（期望 3：customers / quoter_quotes / quote_version_snapshot 复合）
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='customer_po' AND con.contype='f';
--
-- [7] 索引存在（期望 idx_customer_po_quote / idx_customer_po_customer）
-- SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='customer_po' ORDER BY indexname;
--
-- [8] RLS 启用（期望 relrowsecurity=true）
-- SELECT c.relname, c.relrowsecurity FROM pg_class c
-- WHERE c.relnamespace='public'::regnamespace AND c.relname='customer_po';
--
-- [9] 【CHECK 3】不能绑定非法 snapshot 版 —— 必须失败（FK 违反）
--     用一个真实存在的 quote_id + 不存在的 version=999999，预期 ERROR。测完无需清理（未插入）。
-- INSERT INTO public.customer_po (po_number, customer_id, quote_id, quote_snapshot_version)
-- SELECT 'PO-FKTEST', q.customer_id, q.id, 999999
-- FROM public.quoter_quotes q WHERE q.customer_id IS NOT NULL LIMIT 1;
--   期望: ERROR insert or update on table "customer_po" violates foreign key constraint "customer_po_snapshot_fk"
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行；本文件正常执行不含回滚）
-- ------------------------------------------------------------
-- DROP TABLE IF EXISTS public.customer_po;   -- 索引/策略/约束随表 DROP；不影响任何现有表
-- ============================================================
