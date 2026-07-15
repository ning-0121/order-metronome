-- PREPARED ONLY: do not apply without database-change approval.
CREATE TABLE IF NOT EXISTS public.size_chart_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL UNIQUE REFERENCES public.order_attachments(id) ON DELETE CASCADE,
  checksum_sha256 text NOT NULL,
  parse_status text NOT NULL CHECK (parse_status IN ('PARSING','PARSED','FAILED','NEEDS_REVIEW','APPROVED')),
  parsed_json jsonb,
  failure_reason text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, checksum_sha256)
);

ALTER TABLE public.size_chart_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "size_chart_imports_authenticated" ON public.size_chart_imports
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
