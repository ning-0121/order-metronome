-- ============================================================
-- Order Metronome 2.0 — Runtime Engine Phase 1 数据层
-- 投影层（projection layer）：仅作为现有 milestones / delay_requests /
-- order_decision_reviews / agent_actions 的派生只读视图。
-- 不替代任何现有表的写入逻辑。
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. runtime_events — append-only 事件源
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.runtime_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  event_source  text,
  severity      text DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  payload_json  jsonb,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_order_time
  ON public.runtime_events(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_events_type
  ON public.runtime_events(event_type);

COMMENT ON TABLE  public.runtime_events IS '运行时事件源（append-only），所有 confidence 重算的输入';
COMMENT ON COLUMN public.runtime_events.event_type IS 'milestone_status_changed | delay_approved | anchor_changed | amendment_applied | external_signal';

-- ─────────────────────────────────────────────────────────────
-- 2. runtime_orders — 每订单最新投影状态
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.runtime_orders (
  order_id              uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  delivery_confidence   int  CHECK (delivery_confidence >= 0 AND delivery_confidence <= 100),
  risk_level            text CHECK (risk_level IN ('green', 'yellow', 'orange', 'red', 'gray')),
  predicted_finish_date date,
  buffer_days           int,
  last_event_id         uuid REFERENCES public.runtime_events(id) ON DELETE SET NULL,
  last_recomputed_at    timestamptz DEFAULT now(),
  explain_json          jsonb,
  version               int NOT NULL DEFAULT 1,
  updated_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_orders_risk
  ON public.runtime_orders(risk_level);
CREATE INDEX IF NOT EXISTS idx_runtime_orders_confidence
  ON public.runtime_orders(delivery_confidence);

COMMENT ON TABLE  public.runtime_orders IS '每订单的最新交付置信度投影（来源于 runtime_events 重算）';
COMMENT ON COLUMN public.runtime_orders.delivery_confidence IS '0-100，准时交付置信度';
COMMENT ON COLUMN public.runtime_orders.risk_level IS 'green ≥85 / yellow 70-85 / orange 50-70 / red <50 / gray 未计算';
COMMENT ON COLUMN public.runtime_orders.explain_json IS '人类可读解释：headline + reasons + next_blocker + next_action';
COMMENT ON COLUMN public.runtime_orders.version IS '乐观并发版本号';

-- ─────────────────────────────────────────────────────────────
-- 3. RLS — 严格按订单关系过滤
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runtime_orders ENABLE ROW LEVEL SECURITY;

-- helper: 当前用户的 roles（如果 profiles 有 roles 数组）
-- 复用 is_admin_user(auth.uid()) — 项目已有
-- 同时允许 finance / admin_assistant / production_manager 看全量

CREATE OR REPLACE FUNCTION public.can_see_all_orders(uid uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT public.is_admin_user(uid)
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = uid
          AND (
            p.role IN ('finance', 'admin_assistant', 'production_manager')
            OR (p.roles && ARRAY['finance', 'admin_assistant', 'production_manager']::text[])
          )
      );
$$;

-- runtime_events 读：admin/finance/admin_assistant/production_manager 全部；
--                    其他用户只能读自己负责或参与的订单的事件
DROP POLICY IF EXISTS "runtime_events_select" ON public.runtime_events;
CREATE POLICY "runtime_events_select" ON public.runtime_events
  FOR SELECT USING (
    public.can_see_all_orders(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = runtime_events.order_id
        AND (o.owner_user_id = auth.uid() OR o.created_by = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.milestones m
      WHERE m.order_id = runtime_events.order_id
        AND m.owner_user_id = auth.uid()
    )
  );

-- 写：仅 service role（不创建 INSERT / UPDATE / DELETE policy，普通用户无写权限）

-- runtime_orders 读：同上
DROP POLICY IF EXISTS "runtime_orders_select" ON public.runtime_orders;
CREATE POLICY "runtime_orders_select" ON public.runtime_orders
  FOR SELECT USING (
    public.can_see_all_orders(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = runtime_orders.order_id
        AND (o.owner_user_id = auth.uid() OR o.created_by = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.milestones m
      WHERE m.order_id = runtime_orders.order_id
        AND m.owner_user_id = auth.uid()
    )
  );

-- 写：仅 service role（同上）

-- ─────────────────────────────────────────────────────────────
-- Rollback（如需回滚 Phase 1，按顺序执行下面 4 段）
-- ─────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS "runtime_orders_select" ON public.runtime_orders;
-- DROP POLICY IF EXISTS "runtime_events_select" ON public.runtime_events;
-- DROP TABLE IF EXISTS public.runtime_orders;
-- DROP TABLE IF EXISTS public.runtime_events;
-- DROP FUNCTION IF EXISTS public.can_see_all_orders(uuid);
