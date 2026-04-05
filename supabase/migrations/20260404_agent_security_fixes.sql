-- ===== 2026-04-04 Agent 安全修复 =====

-- C4: dedup_key 唯一约束（防重复建议）
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_actions_dedup_unique
  ON public.agent_actions(dedup_key) WHERE status IN ('pending', 'executing');

-- C3: 新增 executing 状态（幂等性保护）
ALTER TABLE public.agent_actions DROP CONSTRAINT IF EXISTS agent_actions_status_check;
ALTER TABLE public.agent_actions ADD CONSTRAINT agent_actions_status_check
  CHECK (status IN ('pending', 'executing', 'executed', 'dismissed', 'expired'));

-- 性能索引：executed_at 用于熔断查询
CREATE INDEX IF NOT EXISTS idx_agent_actions_executed_at
  ON public.agent_actions(executed_at) WHERE status = 'executed';
