-- ============================================================
-- 采购 P2a — 采购单风险驱动审批（纯加法）
-- Supabase: scrtebexbxablybqpdla（QIMO）
-- Date: 2026-07-01
-- 依据: docs/Designs/Procurement-Execution-Flow.md §4 审批（差异/风险驱动）
-- ------------------------------------------------------------
-- 性质: 纯加法。只给 purchase_orders 加审批维度列（不动 status CHECK / 现有列）。
--   审批用独立 approval_status 维度，status 仍 draft→placed；风险单必须 approved 才能 placed。
--   阈值是代码常量（大额5万/价差5%/账期规则），不入 schema。
-- ============================================================

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected'));
-- 需要哪些审批（['procurement'] / ['finance'] / ['procurement','finance']）
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS approval_required_by text[] DEFAULT '{}';
-- 命中的风险触发原因（['large_amount','price_variance','new_supplier','over_budget','non_standard_terms']）
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS approval_reasons   text[] DEFAULT '{}';
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS approved_by        uuid;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS approved_at        timestamptz;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS approval_note      text;

CREATE INDEX IF NOT EXISTS idx_po_approval_status ON public.purchase_orders(approval_status);

COMMENT ON COLUMN public.purchase_orders.approval_status IS
  '审批维度(独立于 status)：not_required(标准单快路径)/pending/approved/rejected。风险单须 approved 才能 placed。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 单独运行）
-- ------------------------------------------------------------
-- [1] 新列齐（期望 6 行）
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='purchase_orders'
--   AND column_name IN ('approval_status','approval_required_by','approval_reasons','approved_by','approved_at','approval_note')
-- ORDER BY column_name;
--
-- [2] approval_status CHECK 生效（期望默认 not_required）
-- SELECT column_default FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='purchase_orders' AND column_name='approval_status';
--
-- [3] status CHECK 未被动（仍 draft..cancelled，未加 pending_approval）
-- SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='purchase_orders' AND con.contype='c' AND pg_get_constraintdef(con.oid) ILIKE '%status%';
--
-- [4] 索引存在
-- SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='purchase_orders' AND indexname='idx_po_approval_status';
-- ============================================================

-- ============================================================
-- 回滚 SQL
-- ------------------------------------------------------------
-- ALTER TABLE public.purchase_orders
--   DROP COLUMN IF EXISTS approval_status, DROP COLUMN IF EXISTS approval_required_by,
--   DROP COLUMN IF EXISTS approval_reasons, DROP COLUMN IF EXISTS approved_by,
--   DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS approval_note;
-- ============================================================
