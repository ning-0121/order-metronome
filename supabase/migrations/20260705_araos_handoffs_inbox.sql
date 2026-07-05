-- ===== [2026-07-05] araos → QIMO 赢单交接收件箱(客户同步 Phase 1 · 方案1)=====
-- 方案1 口径:araos 赢单 → 推「客户 + 赢单通知」到 QIMO,QIMO 落客户(写 source_araos_company_id)
--            + 通知业务来手动建单。**不自动建 PO/订单**(Order 是 PO 派生物,定价建单仍人工)。
-- 幂等键 = araos_order_id(唯一约束);重投同单命中已处理 → 不重复建客户/不重复通知。
-- 只被 service-role(契约端点)写;无用户直读 → RLS 开、无策略(默认拒绝)。

CREATE TABLE IF NOT EXISTS public.araos_handoffs_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  araos_order_id text NOT NULL,
  araos_company_id text,
  event_type text NOT NULL DEFAULT 'deal_won',
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received',   -- received / processed / error
  qimo_customer_id uuid,
  customer_matched boolean NOT NULL DEFAULT false,
  match_path text,                            -- source / name / created
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_araos_handoffs_inbox_order
  ON public.araos_handoffs_inbox (araos_order_id);

ALTER TABLE public.araos_handoffs_inbox ENABLE ROW LEVEL SECURITY;
-- 无策略 = 对 anon/authenticated 默认拒绝;service-role 绕过 RLS 正常读写。

COMMENT ON TABLE public.araos_handoffs_inbox IS
  'araos 赢单交接收件箱(方案1):幂等落客户同步 + 赢单通知;不自动建单。';
