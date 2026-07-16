-- QIMO concurrent order responsibilities — additive, no backfill.
-- REVIEW REQUIRED. Do not run against Production without CEO approval.

CREATE TABLE IF NOT EXISTS public.order_responsibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  responsibility_type text NOT NULL CHECK (responsibility_type IN (
    'development_owner','business_execution_owner','production_manager_owner',
    'production_follow_up_owner','procurement_owner','logistics_owner','finance_owner'
  )),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','superseded')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  assigned_by uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  assignment_reason text NOT NULL,
  ended_by uuid REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  end_reason text,
  source_type text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('handoff','manual','workflow','migration')),
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active' AND ends_at IS NULL AND ended_by IS NULL)
      OR (status <> 'active' AND ends_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_active_responsibility
  ON public.order_responsibilities(order_id, responsibility_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_order_responsibilities_user_active
  ON public.order_responsibilities(user_id, responsibility_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_order_responsibilities_order_history
  ON public.order_responsibilities(order_id, responsibility_type, starts_at DESC);

CREATE TABLE IF NOT EXISTS public.order_operational_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  decision_type text NOT NULL CHECK (decision_type IN ('factory','production_schedule','admin_override')),
  previous_value jsonb,
  new_value jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE RESTRICT,
  actor_roles text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_operational_decisions_order
  ON public.order_operational_decisions(order_id, created_at DESC);

ALTER TABLE public.order_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_operational_decisions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='order_responsibilities' AND policyname='order_responsibilities_select') THEN
    CREATE POLICY order_responsibilities_select ON public.order_responsibilities
      FOR SELECT TO authenticated USING (public.user_can_access_order(auth.uid(), order_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='order_operational_decisions' AND policyname='order_operational_decisions_select') THEN
    CREATE POLICY order_operational_decisions_select ON public.order_operational_decisions
      FOR SELECT TO authenticated USING (public.user_can_access_order(auth.uid(), order_id));
  END IF;
END $$;

-- No client INSERT/UPDATE/DELETE policies. Writes use authenticated server actions + service role.
CREATE OR REPLACE FUNCTION public.replace_order_responsibility(
  p_order_id uuid, p_type text, p_user_id uuid, p_actor_id uuid,
  p_reason text, p_source_type text DEFAULT 'manual', p_source_id text DEFAULT NULL
) RETURNS public.order_responsibilities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_row public.order_responsibilities; result_row public.order_responsibilities;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'assignment_reason_required'; END IF;
  -- Serialize even the first assignment. Locking only an existing responsibility
  -- row leaves a race when two writers both observe no active row.
  PERFORM 1 FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  SELECT * INTO current_row FROM public.order_responsibilities
   WHERE order_id=p_order_id AND responsibility_type=p_type AND status='active' FOR UPDATE;
  IF current_row.user_id = p_user_id THEN RETURN current_row; END IF;
  IF current_row.id IS NOT NULL THEN
    UPDATE public.order_responsibilities SET status='superseded', ends_at=now(), ended_by=p_actor_id,
      end_reason=p_reason, updated_at=now() WHERE id=current_row.id;
  END IF;
  INSERT INTO public.order_responsibilities(order_id,responsibility_type,user_id,assigned_by,assignment_reason,source_type,source_id)
  VALUES(p_order_id,p_type,p_user_id,p_actor_id,p_reason,p_source_type,p_source_id) RETURNING * INTO result_row;
  RETURN result_row;
END $$;
REVOKE ALL ON FUNCTION public.replace_order_responsibility(uuid,text,uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_order_responsibility(uuid,text,uuid,uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.end_order_responsibility(
  p_order_id uuid, p_type text, p_actor_id uuid, p_reason text
) RETURNS public.order_responsibilities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_row public.order_responsibilities;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'end_reason_required'; END IF;
  PERFORM 1 FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  SELECT * INTO current_row FROM public.order_responsibilities
   WHERE order_id=p_order_id AND responsibility_type=p_type AND status='active' FOR UPDATE;
  IF current_row.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.order_responsibilities SET status='ended', ends_at=now(), ended_by=p_actor_id,
    end_reason=btrim(p_reason), updated_at=now() WHERE id=current_row.id RETURNING * INTO current_row;
  RETURN current_row;
END $$;
REVOKE ALL ON FUNCTION public.end_order_responsibility(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_order_responsibility(uuid,text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.set_order_responsibility_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_order_responsibilities_updated_at'
    AND tgrelid='public.order_responsibilities'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_order_responsibilities_updated_at
    BEFORE UPDATE ON public.order_responsibilities
    FOR EACH ROW EXECUTE FUNCTION public.set_order_responsibility_updated_at();
  END IF;
END $$;

COMMENT ON TABLE public.order_responsibilities IS 'Concurrent order responsibilities; never replaces role membership or approval authority.';
COMMENT ON TABLE public.order_operational_decisions IS 'Immutable audit of final factory/schedule/admin override decisions.';
-- No UPDATE/backfill of orders, milestones or historical records.
