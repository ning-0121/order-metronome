-- ===== 2026-04-04 Agent 多步计划 — 动作链 =====

-- 动作链：当前动作执行后，延迟N小时后自动生成下一步
ALTER TABLE public.agent_actions ADD COLUMN IF NOT EXISTS chain_next_type text;
ALTER TABLE public.agent_actions ADD COLUMN IF NOT EXISTS chain_delay_hours integer DEFAULT 0;
ALTER TABLE public.agent_actions ADD COLUMN IF NOT EXISTS chain_step integer DEFAULT 1;
ALTER TABLE public.agent_actions ADD COLUMN IF NOT EXISTS chain_id text;

COMMENT ON COLUMN public.agent_actions.chain_next_type IS '链式动作：当前执行后下一步动作类型';
COMMENT ON COLUMN public.agent_actions.chain_delay_hours IS '链式动作：等待N小时后执行下一步';
COMMENT ON COLUMN public.agent_actions.chain_step IS '链式动作：当前是第几步';
COMMENT ON COLUMN public.agent_actions.chain_id IS '链式动作：同一链的唯一标识';
