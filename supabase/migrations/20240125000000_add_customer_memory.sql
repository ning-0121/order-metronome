-- Customer Memory Card V1: reduce execution errors, transfer experience into system memory
-- customer_id: V1 uses customer_name (text) as identifier; no separate customers table yet
CREATE TABLE IF NOT EXISTS public.customer_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  source_type text NOT NULL,
  content text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  risk_level text NOT NULL DEFAULT 'medium',
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_memory_customer_id ON public.customer_memory(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_memory_order_id ON public.customer_memory(order_id);
CREATE INDEX IF NOT EXISTS idx_customer_memory_created_at ON public.customer_memory(created_at DESC);

ALTER TABLE public.customer_memory ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read (hints are shared context)
CREATE POLICY "Authenticated can select customer_memory"
  ON public.customer_memory FOR SELECT
  TO authenticated
  USING (true);

-- Users can only insert as themselves
CREATE POLICY "Authenticated can insert own customer_memory"
  ON public.customer_memory FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

COMMENT ON TABLE public.customer_memory IS 'V1 Customer memory: delay/block/manual notes keyed by customer. customer_id = customer_name for V1.';
