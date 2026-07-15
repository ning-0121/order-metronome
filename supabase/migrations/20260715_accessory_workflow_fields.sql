-- Additive migration. Existing BOM rows remain NULL: no historical basis is inferred.
ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS consumption_basis text NULL
    CHECK (consumption_basis IS NULL OR consumption_basis IN (
      'PER_SET','PER_COMPONENT','PER_PIECE','PER_ORDER','PER_KG','PER_METER','PER_PACK','MANUAL_TOTAL'
    )),
  ADD COLUMN IF NOT EXISTS sample_reference text,
  ADD COLUMN IF NOT EXISTS position_description text;

-- Quote/purchase prices remain in existing cost-baseline and procurement-line tables;
-- duplicating them onto materials_bom would create conflicting financial truth.
CREATE TABLE IF NOT EXISTS public.accessory_import_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  source_attachment_id uuid NOT NULL REFERENCES public.order_attachments(id) ON DELETE RESTRICT,
  source_row_number integer CHECK (source_row_number IS NULL OR source_row_number > 0),
  matched_bom_id uuid REFERENCES public.materials_bom(id) ON DELETE SET NULL,
  parser_version text NOT NULL,
  import_status text NOT NULL DEFAULT 'SOURCE_IMPORTED' CHECK (import_status IN (
    'SOURCE_IMPORTED','MATCHED_TO_EXISTING','NEW_ACCESSORY','NEEDS_REVIEW','APPROVED','EXCLUDED'
  )),
  source_value jsonb NOT NULL,
  extracted_value jsonb NOT NULL,
  approved_value jsonb,
  missing_fields text[] NOT NULL DEFAULT '{}',
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accessory_candidate_review_consistency CHECK (
    import_status NOT IN ('APPROVED','EXCLUDED')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT accessory_candidate_approval_payload CHECK (
    import_status <> 'APPROVED' OR approved_value IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_accessory_candidates_order_status
  ON public.accessory_import_candidates(order_id, import_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accessory_candidates_source
  ON public.accessory_import_candidates(source_attachment_id, source_row_number);
CREATE INDEX IF NOT EXISTS idx_accessory_candidates_bom
  ON public.accessory_import_candidates(matched_bom_id) WHERE matched_bom_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_accessory_candidate_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accessory_candidate_updated_at ON public.accessory_import_candidates;
CREATE TRIGGER trg_accessory_candidate_updated_at
BEFORE UPDATE ON public.accessory_import_candidates
FOR EACH ROW EXECUTE FUNCTION public.set_accessory_candidate_updated_at();

ALTER TABLE public.accessory_import_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "accessory_candidates_select" ON public.accessory_import_candidates FOR SELECT TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id));
CREATE POLICY "accessory_candidates_insert" ON public.accessory_import_candidates FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.user_can_access_order(auth.uid(), order_id));
CREATE POLICY "accessory_candidates_update" ON public.accessory_import_candidates FOR UPDATE TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id))
  WITH CHECK (
    public.user_can_access_order(auth.uid(), order_id)
    AND (updated_by IS NULL OR updated_by = auth.uid())
    AND (reviewed_by IS NULL OR reviewed_by = auth.uid())
  );
CREATE POLICY "accessory_candidates_delete" ON public.accessory_import_candidates FOR DELETE TO authenticated
  USING (public.user_can_access_order(auth.uid(), order_id));

COMMENT ON TABLE public.accessory_import_candidates IS
  'Review-only import candidates. No trigger or foreign-key cascade creates procurement lines.';
