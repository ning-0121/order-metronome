-- ===== 2026-04-19 Agent Batch Jobs — Anthropic Batch API 异步增强 =====
--
-- 用途：
--   agent-scan 每小时运行时，把需要 AI 增强的订单打包成 Anthropic Batch 请求，
--   异步提交（节省50%费用）。下次 cron 运行时拉取结果，反写到 agent_actions。
--
-- 生命周期：submitted → applied | failed
-- 一般在提交后 1-3 小时内完成（Anthropic Batch SLA ≤24h）

CREATE TABLE IF NOT EXISTS agent_batch_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Anthropic Batch ID
  batch_id    text NOT NULL,

  -- submitted → applied | failed
  status      text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'applied', 'failed')),

  -- 每个 batch item 的映射信息，供结果回填用
  -- 格式: [{ customId, orderId, highActionIds: string[] }]
  job_data    jsonb NOT NULL DEFAULT '[]',

  submitted_at  timestamptz DEFAULT now(),
  applied_at    timestamptz,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_batch_jobs_status ON agent_batch_jobs(status, submitted_at);

-- RLS（Service Role 内部使用，无需公开）
ALTER TABLE agent_batch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_batch_jobs_service_only" ON agent_batch_jobs
  USING (false);   -- 只允许 service_role bypass，前端不可读写
