-- ===== [2026-07-05] 财务外发发件箱(财务审计 A3)=====
-- 问题:sync*ToFinance 全是 fire-and-forget,失败仅 console.warn,无 outbox/重试/告警 →
--       财务系统宕机/超时期间,PO 应付、收货核销、取消冲销等外发静默丢单,事后无可见记录可补发。
-- 方案:失败落 integration_outbox(幂等 request_id)→ cron 每 15 分钟退避重试 → 超上限置 dead 可见。

CREATE TABLE IF NOT EXISTS public.integration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL DEFAULT 'finance',
  event text NOT NULL,
  payload jsonb NOT NULL,          -- 原始 data,重发时按同一 event+data 重建 payload
  request_id text,                 -- 幂等键(与发送侧 deterministicRequestId 一致)
  status text NOT NULL DEFAULT 'failed',   -- failed(待重试) / sent / dead(超上限,待人工)
  attempts int NOT NULL DEFAULT 1,
  last_error text,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_request_id ON public.integration_outbox (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_due ON public.integration_outbox (status, next_retry_at);

ALTER TABLE public.integration_outbox ENABLE ROW LEVEL SECURITY;
-- service-role 写(绕过 RLS);登录用户可读(未来给管理页看失败队列)。
CREATE POLICY outbox_read ON public.integration_outbox FOR SELECT TO authenticated USING (true);

-- 回滚:DROP TABLE IF EXISTS public.integration_outbox;
