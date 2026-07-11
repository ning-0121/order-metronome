-- ============================================================
-- 多客户PO合单 — order_customer_pos（订单的来源客户PO容器）
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- 设计依据: docs/Designs/Multi-PO-Merge-Order-V1.0.md
-- ------------------------------------------------------------
-- 性质: 纯加法。只加 1 张新表 + 2 索引 + RLS。不碰 orders / order_line_items / 任何现有表。
-- 背景: 客户裂分多张 PO 但交期一致 → 绮陌合并为一个内部订单号统一生产。
--   本表记「这个内部订单由哪几张客户PO合成」:一张客户PO一行,存 PO 号/原始文件/AI原文快照/本PO金额。
--   ❗款色码明细不进本表(仍归 order_line_items 唯一真相),本表只存 PO 级元数据。
-- 口径(用户 2026-07-11 拍板):
--   · 财务按 internal_order_no 汇总,po_amount 仅信息留存,不按它拆应收 → 本列可空。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.order_customer_pos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK 必须显式声明,否则 PostgREST 嵌套 join 静默报 "Could not find a relationship"(CLAUDE.md 血泪教训)
  order_id           uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_po_number text NOT NULL,                        -- 客户自己的 PO 号
  seq                int  NOT NULL DEFAULT 1,              -- PO 批次序 1/2/3…(生产单按批次拆用)
  attachment_id      uuid REFERENCES public.order_attachments(id) ON DELETE SET NULL, -- 原始PO文件存档(可空)
  po_parse_snapshot  jsonb,                                -- AI/解析原文冻结底档(可空)
  po_amount          numeric,                              -- 本PO金额(可空,仅信息;财务按内部单号汇总,不按它拆)
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES auth.users(id),
  -- 同一订单内 PO 号唯一(防重复灌同一张 PO)
  CONSTRAINT order_customer_pos_uniq UNIQUE (order_id, customer_po_number)
);

CREATE INDEX IF NOT EXISTS idx_order_customer_pos_order ON public.order_customer_pos(order_id);

-- RLS:与订单子表一致(登录可读写;写在建单链路里走 service-role/登录会话)。
-- ⚠️ 用 auth.uid() IS NOT NULL 而非 USING(true):与全库 RLS 基线一致,避免匿名可写的安全洞。
ALTER TABLE public.order_customer_pos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ocp_select_auth" ON public.order_customer_pos;
CREATE POLICY "ocp_select_auth" ON public.order_customer_pos FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "ocp_insert_auth" ON public.order_customer_pos;
CREATE POLICY "ocp_insert_auth" ON public.order_customer_pos FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "ocp_update_auth" ON public.order_customer_pos;
CREATE POLICY "ocp_update_auth" ON public.order_customer_pos FOR UPDATE USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.order_customer_pos IS
  '多PO合单:一个内部订单的来源客户PO容器。一张客户PO一行,存PO号/原始文件/AI原文快照/本PO金额。款色明细不进本表(归 order_line_items)。po_amount 仅信息,财务按 internal_order_no 汇总。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- 逐条真实返回并核对期望,全 PASS 才允许进入写码/build/commit/push。
-- ------------------------------------------------------------
-- [1] 表存在(期望 1 行)
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' AND table_name='order_customer_pos';
--
-- [2] 列集合正确(期望恰好这 8 列)
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_customer_pos' ORDER BY ordinal_position;
--   期望: id, order_id, customer_po_number, seq, attachment_id, po_parse_snapshot, po_amount, created_at, created_by
--
-- [3] UNIQUE(order_id, customer_po_number) 存在(期望 1 行 order_customer_pos_uniq)
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='order_customer_pos' AND con.contype='u';
--
-- [4] FK→orders 存在且 ON DELETE CASCADE(期望含 orders + CASCADE)
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='order_customer_pos' AND con.contype='f'
--   AND pg_get_constraintdef(con.oid) ILIKE '%orders%';
--
-- [5] RLS 已启用(期望 relrowsecurity=true)
-- SELECT relrowsecurity FROM pg_class WHERE relname='order_customer_pos';
--
-- [6] 3 条 RLS 策略存在(期望 3 行 select/insert/update)
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='order_customer_pos' ORDER BY policyname;
-- ============================================================
