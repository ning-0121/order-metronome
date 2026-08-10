-- PR #31 UAT fixture registry draft
-- DO NOT APPLY TO PRODUCTION AS PART OF PR #31.
-- This is a migration draft for code review only.

CREATE TABLE IF NOT EXISTS public.uat_fixtures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_type text NOT NULL CHECK (fixture_type IN ('PR31_BUDGET_UAT')),
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','UAT_COMPLETE','CLEANUP_PENDING','CLEANED','EXPIRED')),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  target_order_id uuid NULL REFERENCES public.orders(id) ON DELETE SET NULL,
  target_bom_id uuid NULL REFERENCES public.materials_bom(id) ON DELETE SET NULL,
  target_baseline_id uuid NULL REFERENCES public.order_cost_baseline(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NULL,
  cleanup_requested_at timestamptz NULL,
  cleanup_completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.tg_uat_fixtures_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uat_fixtures_set_updated_at ON public.uat_fixtures;
CREATE TRIGGER uat_fixtures_set_updated_at
  BEFORE UPDATE ON public.uat_fixtures
  FOR EACH ROW EXECUTE FUNCTION public.tg_uat_fixtures_set_updated_at();

CREATE TABLE IF NOT EXISTS public.uat_fixture_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id uuid NOT NULL REFERENCES public.uat_fixtures(id) ON DELETE CASCADE,
  asset_table text NOT NULL,
  asset_id uuid NOT NULL,
  asset_role text NOT NULL,
  cleanup_mode text NOT NULL CHECK (cleanup_mode IN ('delete','restore')),
  created_at timestamptz NOT NULL DEFAULT now(),
  cleaned_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_uat_fixture_assets_fixture_id ON public.uat_fixture_assets(fixture_id);
CREATE INDEX IF NOT EXISTS idx_uat_fixtures_owner_status ON public.uat_fixtures(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_uat_fixtures_type_status ON public.uat_fixtures(fixture_type, status);

ALTER TABLE public.uat_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_fixture_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uat_fixtures_select ON public.uat_fixtures;
CREATE POLICY uat_fixtures_select ON public.uat_fixtures
  FOR SELECT USING (auth.uid() IS NOT NULL AND owner_user_id = auth.uid());

DROP POLICY IF EXISTS uat_fixtures_insert ON public.uat_fixtures;
CREATE POLICY uat_fixtures_insert ON public.uat_fixtures
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL AND owner_user_id = auth.uid());

DROP POLICY IF EXISTS uat_fixtures_update ON public.uat_fixtures;
CREATE POLICY uat_fixtures_update ON public.uat_fixtures
  FOR UPDATE USING (auth.uid() IS NOT NULL AND owner_user_id = auth.uid())
  WITH CHECK (auth.uid() IS NOT NULL AND owner_user_id = auth.uid());

DROP POLICY IF EXISTS uat_fixture_assets_select ON public.uat_fixture_assets;
CREATE POLICY uat_fixture_assets_select ON public.uat_fixture_assets
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.uat_fixtures f
      WHERE f.id = fixture_id
        AND f.owner_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS uat_fixture_assets_insert ON public.uat_fixture_assets;
CREATE POLICY uat_fixture_assets_insert ON public.uat_fixture_assets
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.uat_fixtures f
      WHERE f.id = fixture_id
        AND f.owner_user_id = auth.uid()
        AND f.status IN ('DRAFT','ACTIVE')
    )
  );

DROP POLICY IF EXISTS uat_fixture_assets_update ON public.uat_fixture_assets;
CREATE POLICY uat_fixture_assets_update ON public.uat_fixture_assets
  FOR UPDATE USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.uat_fixtures f
      WHERE f.id = fixture_id
        AND f.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.uat_fixtures f
      WHERE f.id = fixture_id
        AND f.owner_user_id = auth.uid()
    )
  );

-- Optional audit table for cleanup reports.
CREATE TABLE IF NOT EXISTS public.uat_fixture_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id uuid NOT NULL REFERENCES public.uat_fixtures(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL,
  dry_run jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.uat_fixture_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS uat_fixture_audit_select ON public.uat_fixture_audit;
CREATE POLICY uat_fixture_audit_select ON public.uat_fixture_audit
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.uat_fixtures f
      WHERE f.id = fixture_id
        AND f.owner_user_id = auth.uid()
    )
  );

-- NOTE:
-- This draft intentionally does not modify existing orders/materials_bom RLS.
-- Fixture cleanup must remain scoped to assets registered above.
