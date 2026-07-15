-- Additive migration. Apply only to an isolated staging/branch database first.
CREATE TABLE IF NOT EXISTS public.size_chart_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL UNIQUE REFERENCES public.order_attachments(id) ON DELETE CASCADE,
  document_type text NOT NULL DEFAULT 'size_chart' CHECK (document_type = 'size_chart'),
  source_filename text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL,
  worksheet_name text,
  parse_status text NOT NULL DEFAULT 'UPLOADED' CHECK (parse_status IN (
    'UPLOADED','PARSING','PARSED','NEEDS_REVIEW','APPROVED','FAILED','DUPLICATE'
  )),
  parsed_row_count integer NOT NULL DEFAULT 0 CHECK (parsed_row_count >= 0),
  error_code text,
  safe_error_message text,
  parsed_json jsonb,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT size_chart_review_consistency CHECK (
    parse_status <> 'APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_size_chart_imports_order_status
  ON public.size_chart_imports(order_id, parse_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_size_chart_imports_duplicate_lookup
  ON public.size_chart_imports(order_id, document_type, checksum_sha256);

CREATE OR REPLACE FUNCTION public.set_size_chart_import_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_size_chart_import_updated_at ON public.size_chart_imports;
CREATE TRIGGER trg_size_chart_import_updated_at
BEFORE UPDATE ON public.size_chart_imports
FOR EACH ROW EXECUTE FUNCTION public.set_size_chart_import_updated_at();

ALTER TABLE public.size_chart_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "size_chart_imports_select" ON public.size_chart_imports;
DROP POLICY IF EXISTS "size_chart_imports_insert" ON public.size_chart_imports;
DROP POLICY IF EXISTS "size_chart_imports_update" ON public.size_chart_imports;
DROP POLICY IF EXISTS "size_chart_imports_delete" ON public.size_chart_imports;

CREATE POLICY "size_chart_imports_select" ON public.size_chart_imports FOR SELECT TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id));
CREATE POLICY "size_chart_imports_insert" ON public.size_chart_imports FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.user_can_access_order(auth.uid(), order_id));
CREATE POLICY "size_chart_imports_update" ON public.size_chart_imports FOR UPDATE TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id))
  WITH CHECK (
    public.user_can_access_order(auth.uid(), order_id)
    AND (updated_by IS NULL OR updated_by = auth.uid())
    AND (reviewed_by IS NULL OR reviewed_by = auth.uid())
  );
CREATE POLICY "size_chart_imports_delete" ON public.size_chart_imports FOR DELETE TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id));

COMMENT ON TABLE public.size_chart_imports IS
  'Deterministic size-chart parse cache. Results require authenticated human review before APPROVED.';
