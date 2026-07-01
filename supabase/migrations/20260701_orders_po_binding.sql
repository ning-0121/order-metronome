-- ============================================================
-- Orders — PO Binding 扩展（Order Intake Convergence · 纯加法）
-- Supabase: scrtebexbxablybqpdla（QIMO）
-- Date: 2026-07-01
-- 依据: Business-Chain-Contract-V1.0 §一(Quote→PO=REFERENCE) + Order Intake Convergence
-- ------------------------------------------------------------
-- 性质: 纯加法。只给 orders 加 5 列 + 2 索引。
--   ❌ 不删/不改任何现有列 · ❌ 不碰 quoter_quotes / quote_line / quote_version_snapshot / customer_po 结构
-- 向后兼容关键: source NOT NULL DEFAULT 'LEGACY'
--   → 所有现有订单 + legacy createOrder 建的订单 **自动 = LEGACY**，legacy 代码零改动。
--   → 只有新 PO 路径显式 UPDATE source='PO' + 绑定列。
-- 注: origin_quote_id 可能已由 phase0a 存在 → IF NOT EXISTS 幂等，不重复/不改。
-- ============================================================

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'LEGACY'
  CHECK (source IN ('PO', 'LEGACY'));
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_po_id uuid REFERENCES public.customer_po(id);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quoter_quotes(id);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS quote_snapshot_version int;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS origin_quote_id uuid;  -- phase0a 或本次；幂等

CREATE INDEX IF NOT EXISTS idx_orders_customer_po ON public.orders(customer_po_id);
CREATE INDEX IF NOT EXISTS idx_orders_source      ON public.orders(source);

COMMENT ON COLUMN public.orders.source IS
  'Order 来源：LEGACY（手填/OCR，默认，向后兼容）| PO（从 approved 快照派生）。';
COMMENT ON COLUMN public.orders.customer_po_id IS
  'PO 路径：绑定的 customer_po.id（Order 是 PO 消费产物；legacy 为 NULL）。';

-- ============================================================
-- 验证 SQL（DB 门禁 — Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 5 列存在（期望 5 行）
-- SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='orders'
--   AND column_name IN ('source','customer_po_id','quote_id','quote_snapshot_version','origin_quote_id')
-- ORDER BY column_name;
--
-- [2] source 向后兼容：现有订单全部 = LEGACY（期望 legacy_count = 全部；po_count = 0）
-- SELECT source, count(*) FROM public.orders GROUP BY source;
--
-- [3] source CHECK 存在
-- SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='orders' AND con.contype='c' AND pg_get_constraintdef(con.oid) ILIKE '%LEGACY%';
--
-- [4] customer_po_id / quote_id FK 存在（期望 2 行）
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='orders' AND con.contype='f'
--   AND (pg_get_constraintdef(con.oid) ILIKE '%customer_po%' OR pg_get_constraintdef(con.oid) ILIKE '%quoter_quotes%');
--
-- [5] 索引存在
-- SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='orders'
--   AND indexname IN ('idx_orders_customer_po','idx_orders_source');
--
-- [6] 现有列未受损（抽样关键列仍在）
-- SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'
--   AND column_name IN ('id','order_no','customer_id','lifecycle_status','quantity') ORDER BY column_name;
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行）
-- ------------------------------------------------------------
-- DROP INDEX IF EXISTS public.idx_orders_customer_po;
-- DROP INDEX IF EXISTS public.idx_orders_source;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS source;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS customer_po_id;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS quote_id;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS quote_snapshot_version;
-- 注: origin_quote_id 若属 phase0a，不在本回滚删除范围（避免误删既有）。
-- ============================================================
