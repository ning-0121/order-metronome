-- Mail Intake + Customer Memory V1 (TradeGuard)
-- 1) mail_inbox: store ingested emails (CC/BCC tradeguard@qimoclothing.com)
-- 2) customer_memory: support source_type 'mail', optional content_json, nullable created_by for mail

-- =========================
-- mail_inbox
-- =========================
CREATE TABLE IF NOT EXISTS public.mail_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_email text NOT NULL,
  subject text NOT NULL DEFAULT '',
  raw_body text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL DEFAULT now(),
  extracted_po text,
  extracted_style text,
  customer_id text,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mail_inbox_received_at ON public.mail_inbox(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_inbox_order_id ON public.mail_inbox(order_id);
CREATE INDEX IF NOT EXISTS idx_mail_inbox_customer_id ON public.mail_inbox(customer_id);
CREATE INDEX IF NOT EXISTS idx_mail_inbox_extracted_po ON public.mail_inbox(extracted_po) WHERE extracted_po IS NOT NULL;

ALTER TABLE public.mail_inbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select mail_inbox"
  ON public.mail_inbox FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can insert mail_inbox"
  ON public.mail_inbox FOR INSERT TO authenticated
  WITH CHECK (true);

COMMENT ON TABLE public.mail_inbox IS 'V1 Mail intake: emails CC/BCC to TradeGuard; extracted PO/style and link to order/customer.';

-- =========================
-- customer_memory: allow mail source (created_by nullable, content_json optional)
-- =========================
ALTER TABLE public.customer_memory
  ALTER COLUMN created_by DROP NOT NULL;

COMMENT ON COLUMN public.customer_memory.created_by IS 'Set for manual/delay sources; NULL for mail intake.';

ALTER TABLE public.customer_memory
  ADD COLUMN IF NOT EXISTS content_json jsonb;

COMMENT ON COLUMN public.customer_memory.content_json IS 'Optional structured content (e.g. from mail: categories, original_quote).';
