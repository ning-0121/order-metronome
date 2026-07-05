-- ===== [2026-07-05] order_finance_events 幂等 + 收紧 RLS(财务审计 A4)=====
-- 问题:建表无唯一键 + finance-callback 不查重 → 5 分钟窗口内重放同一签名回调会重复记一笔资金事件;
--       且 ofe_insert TO anon WITH CHECK(true) → 任意 anon 可绕过签名直写资金事件。

-- ① 幂等键:加 request_id + 唯一索引(重放同一 request_id → ON CONFLICT DO NOTHING)。
ALTER TABLE public.order_finance_events ADD COLUMN IF NOT EXISTS request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ofe_request_id
  ON public.order_finance_events (request_id) WHERE request_id IS NOT NULL;

-- ② 去掉 anon/authenticated INSERT 策略(可绕签名直写)。
--    写入改由 finance-callback 用 service-role(绕过 RLS),不再需要面向普通角色的写策略。
DROP POLICY IF EXISTS ofe_insert ON public.order_finance_events;

-- ③ 读收紧到 authenticated(去掉 anon):节拍器登录用户读资金进度即可。
DROP POLICY IF EXISTS ofe_select ON public.order_finance_events;
CREATE POLICY ofe_select ON public.order_finance_events FOR SELECT TO authenticated USING (true);

-- 回滚:
--   DROP INDEX IF EXISTS uq_ofe_request_id;
--   ALTER TABLE public.order_finance_events DROP COLUMN IF EXISTS request_id;
--   CREATE POLICY ofe_insert ON public.order_finance_events FOR INSERT TO anon, authenticated WITH CHECK (true);
