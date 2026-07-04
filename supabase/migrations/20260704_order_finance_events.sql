-- ============================================================
-- order_finance_events — 接收财务系统的资金进度回传（append-only）
-- 背景：财务的结算/收款/付款完成此前对节拍器全黑盒。财务经签名 webhook 回传
--   settlement.closed / collection.received / payment.completed，节拍器记进本表，
--   可据此展示"款已到/已决算"推进发货节拍。按 order_id(=orders.id, 财务 qimo_order_id)关联。
-- 写入路径：/api/integration/finance-callback（已被 API Key + HMAC 签名保护）。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.order_finance_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid,                      -- = public.orders.id（财务侧 qimo_order_id），弱引用不设 FK
  order_no     text,                      -- QM-YYYYMMDD-XXX，冗余便于查
  event_type   text NOT NULL CHECK (event_type IN ('settlement.closed','collection.received','payment.completed')),
  amount       numeric(15,2),
  currency     text,
  note         text,
  occurred_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ofe_order ON public.order_finance_events(order_id);
CREATE INDEX IF NOT EXISTS idx_ofe_order_no ON public.order_finance_events(order_no);

ALTER TABLE public.order_finance_events ENABLE ROW LEVEL SECURITY;
-- 写入来自受 API Key+签名 保护的 finance-callback（Supabase 侧为 anon 角色）；读供节拍器 UI。
CREATE POLICY ofe_insert ON public.order_finance_events FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY ofe_select ON public.order_finance_events FOR SELECT TO anon, authenticated USING (true);
