-- ============================================================
-- 多PO合单 P3a — order_customer_pos 加 status + split_to_order_id
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- 设计依据: docs/Designs/Multi-PO-PerPO-Operations-P3-V1.0.md 四
-- ------------------------------------------------------------
-- 性质: 纯加法。给 order_customer_pos 加 2 列,表达某张来源PO的局部处置状态。
--   status: active(默认) / cancelled(整张取消) / split_out(拆分成独立子单)
--   split_to_order_id: status=split_out 时指向拆出的子单(P3b 用;P3a 先建列)
-- 依赖: order_customer_pos 表(20260711_order_customer_pos.sql)已建。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

ALTER TABLE public.order_customer_pos
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'split_out')),
  ADD COLUMN IF NOT EXISTS split_to_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.order_customer_pos.status IS
  'P3a:来源PO处置状态。active=正常;cancelled=整张取消(其明细已减到0);split_out=拆分成独立子单(见 split_to_order_id)。';
COMMENT ON COLUMN public.order_customer_pos.split_to_order_id IS
  'P3b:拆分后该PO成了哪张子单(status=split_out 时)。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 两列存在(期望 2 行)
-- SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_customer_pos'
--   AND column_name IN ('status','split_to_order_id') ORDER BY column_name;
--   期望: split_to_order_id(uuid,YES) / status(text,NO,default 'active')
--
-- [2] status CHECK 约束存在(期望含 active/cancelled/split_out)
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='order_customer_pos' AND con.contype='c'
--   AND pg_get_constraintdef(con.oid) ILIKE '%split_out%';
--
-- [3] split_to_order_id FK→orders 存在(期望 1 行含 orders + SET NULL)
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='order_customer_pos' AND con.contype='f'
--   AND pg_get_constraintdef(con.oid) ILIKE '%split_to_order_id%';
--
-- [4] 老数据默认 active(期望 non_active=0)
-- SELECT count(*) FILTER (WHERE status <> 'active') AS non_active FROM public.order_customer_pos;
-- ============================================================
