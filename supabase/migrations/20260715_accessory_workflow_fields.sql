-- PREPARED ONLY: do not apply without database-change approval.
ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS consumption_basis text NOT NULL DEFAULT 'PER_SET'
    CHECK (consumption_basis IN ('PER_SET','PER_COMPONENT','PER_PIECE','PER_ORDER','PER_KG','PER_METER','PER_PACK','MANUAL_TOTAL')),
  ADD COLUMN IF NOT EXISTS sample_reference text,
  ADD COLUMN IF NOT EXISTS position_description text,
  ADD COLUMN IF NOT EXISTS supplier_quote numeric,
  ADD COLUMN IF NOT EXISTS factory_quote numeric,
  ADD COLUMN IF NOT EXISTS purchase_price numeric;

CREATE TABLE IF NOT EXISTS public.accessory_import_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  source_attachment_id uuid REFERENCES public.order_attachments(id) ON DELETE SET NULL,
  matched_bom_id uuid REFERENCES public.materials_bom(id) ON DELETE SET NULL,
  import_status text NOT NULL CHECK (import_status IN (
    'SOURCE_IMPORTED','MATCHED_TO_EXISTING','NEW_ACCESSORY','NEEDS_REVIEW','APPROVED','EXCLUDED'
  )),
  source_value jsonb NOT NULL,
  extracted_value jsonb NOT NULL,
  approved_value jsonb,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.accessory_import_candidates ENABLE ROW LEVEL SECURITY;
