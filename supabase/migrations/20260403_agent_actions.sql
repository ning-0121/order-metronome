-- ===== 2026-04-03 Phase 1 AI Agent — agent_actions 表 =====

CREATE TABLE IF NOT EXISTS public.agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES public.milestones(id) ON DELETE SET NULL,

  -- 建议内容
  action_type text NOT NULL,
  title text NOT NULL,
  description text,
  reason text,
  severity text DEFAULT 'medium',

  -- 执行参数
  action_payload jsonb DEFAULT '{}',

  -- 状态
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executed', 'dismissed', 'expired')),

  -- 执行信息
  executed_by uuid,
  executed_at timestamptz,
  dismissed_by uuid,
  dismissed_at timestamptz,

  -- 回滚
  rollback_data jsonb,
  rolled_back boolean DEFAULT false,

  -- 防重复
  dedup_key text,
  expires_at timestamptz DEFAULT (now() + interval '24 hours'),

  created_at timestamptz DEFAULT now()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_agent_actions_order ON public.agent_actions(order_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON public.agent_actions(status);
CREATE INDEX IF NOT EXISTS idx_agent_actions_dedup ON public.agent_actions(dedup_key) WHERE status = 'pending';

-- RLS
ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_actions_authenticated" ON public.agent_actions
  FOR ALL USING (auth.uid() IS NOT NULL);
