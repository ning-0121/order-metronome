-- ===== 2026-04-08 AI Skills Phase 1 — 基础设施 =====
--
-- 7 个 AI Skill 的共享数据表：
--   1. ai_skill_runs       — 每次 Skill 运行的快照 + 缓存
--   2. ai_skill_actions    — 用户接受 Skill 建议后的动作记录（含回滚信息）
--   3. ai_skill_circuit_state — 熔断器状态
--
-- 设计原则：
--  - 仅 admin 可读（默认对业务员透明）
--  - 默认 shadow mode 开启
--  - 任何 Skill 失败/超时不能影响主业务

-- ════════════════════════════════════════════════
-- 1. ai_skill_runs — 运行快照 + 缓存
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ai_skill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name text NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_id text,

  -- 输入 / 输出
  input_hash text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}',
  output_result jsonb,

  -- 元数据
  source text NOT NULL DEFAULT 'rules' CHECK (source IN ('rules', 'rules+ai', 'cached', 'manual')),
  confidence_score integer CHECK (confidence_score IS NULL OR (confidence_score BETWEEN 0 AND 100)),
  confidence_level text CHECK (confidence_level IS NULL OR confidence_level IN ('high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'timeout', 'shadow')),
  duration_ms integer,
  error_message text,

  -- Shadow mode
  is_shadow boolean NOT NULL DEFAULT false,

  -- 缓存控制
  expires_at timestamptz,
  invalidated_at timestamptz,

  -- 触发来源
  triggered_by text CHECK (triggered_by IS NULL OR triggered_by IN ('user', 'cron', 'event', 'manual')),
  triggered_user_id uuid REFERENCES auth.users(id),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_skill_runs_order_skill
  ON public.ai_skill_runs(order_id, skill_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_skill_runs_cache_lookup
  ON public.ai_skill_runs(skill_name, input_hash, expires_at)
  WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_skill_runs_shadow
  ON public.ai_skill_runs(skill_name, is_shadow, created_at DESC)
  WHERE is_shadow = true;

ALTER TABLE public.ai_skill_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skill_runs_admin_select" ON public.ai_skill_runs;
CREATE POLICY "ai_skill_runs_admin_select" ON public.ai_skill_runs
  FOR SELECT USING (
    auth.uid() IS NOT NULL AND public.user_can_see_all_orders(auth.uid())
  );
DROP POLICY IF EXISTS "ai_skill_runs_admin_insert" ON public.ai_skill_runs;
CREATE POLICY "ai_skill_runs_admin_insert" ON public.ai_skill_runs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);


-- ════════════════════════════════════════════════
-- 2. ai_skill_actions — 用户接受建议后的动作记录
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ai_skill_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.ai_skill_runs(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,

  action_type text NOT NULL,
  action_payload jsonb NOT NULL DEFAULT '{}',

  -- 执行
  executed_by uuid NOT NULL REFERENCES auth.users(id),
  executed_at timestamptz NOT NULL DEFAULT now(),

  -- 回滚
  rollback_available boolean NOT NULL DEFAULT false,
  rollback_until timestamptz,
  rollback_payload jsonb,
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES auth.users(id),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_skill_actions_order
  ON public.ai_skill_actions(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_skill_actions_run
  ON public.ai_skill_actions(run_id);

ALTER TABLE public.ai_skill_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skill_actions_admin" ON public.ai_skill_actions;
CREATE POLICY "ai_skill_actions_admin" ON public.ai_skill_actions
  FOR ALL USING (
    auth.uid() IS NOT NULL AND public.user_can_see_all_orders(auth.uid())
  );


-- ════════════════════════════════════════════════
-- 3. ai_skill_circuit_state — 熔断器状态
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ai_skill_circuit_state (
  skill_name text PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0,
  paused_until timestamptz,
  last_failure_at timestamptz,
  last_failure_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_skill_circuit_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skill_circuit_state_admin" ON public.ai_skill_circuit_state;
CREATE POLICY "ai_skill_circuit_state_admin" ON public.ai_skill_circuit_state
  FOR ALL USING (
    auth.uid() IS NOT NULL AND public.user_can_see_all_orders(auth.uid())
  );

COMMENT ON TABLE public.ai_skill_runs IS '所有 AI Skill 的运行快照 + DB 缓存（admin only）';
COMMENT ON TABLE public.ai_skill_actions IS 'AI Skill 建议被用户接受后的动作记录 + 回滚追溯';
COMMENT ON TABLE public.ai_skill_circuit_state IS 'AI Skill 熔断器状态（连续失败 5 次自动暂停 1h）';
