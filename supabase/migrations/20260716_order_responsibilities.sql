-- QIMO per-order concurrent responsibilities (ADDITIVE ONLY)
-- REVIEW REQUIRED: do not apply to Production without CEO approval.
-- This table supplements orders.owner_user_id (overall Business Execution owner)
-- and milestones.owner_user_id (step executor); it does not overwrite either.

CREATE TABLE IF NOT EXISTS public.order_responsibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  responsibility_type text NOT NULL CHECK (responsibility_type IN (
    'development_owner',
    'business_execution_owner',
    'production_manager_owner',
    'production_follow_up_owner',
    'procurement_owner',
    'logistics_owner',
    'finance_owner'
  )),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  ended_at timestamptz,
  change_reason text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('handoff', 'manual', 'workflow', 'migration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active AND ended_at IS NULL) OR (NOT active AND ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_active_responsibility
  ON public.order_responsibilities(order_id, responsibility_type)
  WHERE active;
CREATE INDEX IF NOT EXISTS idx_order_responsibilities_user_active
  ON public.order_responsibilities(user_id, responsibility_type, active);
CREATE INDEX IF NOT EXISTS idx_order_responsibilities_order
  ON public.order_responsibilities(order_id, active);

ALTER TABLE public.order_responsibilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_responsibilities_select ON public.order_responsibilities;
CREATE POLICY order_responsibilities_select ON public.order_responsibilities
  FOR SELECT TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id));

-- Writes intentionally remain server-only. Server actions must authenticate the actor,
-- verify canonical role capability and store assigned_by from auth.uid().

COMMENT ON TABLE public.order_responsibilities IS
  'Concurrent per-order responsibilities; distinct from role membership and approval authority.';

-- No backfill: historical orders continue deriving business_execution_owner from
-- orders.owner_user_id/created_by and step ownership from milestones until reviewed.
