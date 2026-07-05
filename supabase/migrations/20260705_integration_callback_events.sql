-- ===== [2026-07-05] 财务回调幂等表(复审 H2)=====
-- 问题:finance-callback 的审批回调(price/delay/cancel/milestone/purchase)无幂等键,
--   5 分钟时间戳窗口内重放同一签名回调会二次执行(尤其 purchase 二次下单、milestone 二次完成)。
--   A4 只保了 order_finance_events(资金事件),审批回调未保。
-- 修:回调级幂等键 request_id;回调先查/记 → 命中即 no-op。配合 purchase 分支的状态闸双保险。

CREATE TABLE IF NOT EXISTS public.integration_callback_events (
  request_id  text PRIMARY KEY,
  event       text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.integration_callback_events ENABLE ROW LEVEL SECURITY;
-- service-role 写(绕过 RLS);登录用户可读(排查)。
CREATE POLICY ice_read ON public.integration_callback_events FOR SELECT TO authenticated USING (true);

-- 回滚:DROP TABLE IF EXISTS public.integration_callback_events;
