-- PO 历史自动学习 V1：只存人工确认后的脱敏结构画像，不存完整 PO/价格/数量。
CREATE TABLE IF NOT EXISTS public.po_learning_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key text NOT NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  source_order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  learning_profile jsonb NOT NULL,
  status text NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED','REVOKED')),
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_learning_examples_order_unique UNIQUE (source_order_id)
);

CREATE INDEX IF NOT EXISTS idx_po_learning_customer_approved
  ON public.po_learning_examples(customer_key, approved_at DESC) WHERE status = 'APPROVED';

ALTER TABLE public.po_learning_examples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_learning_examples_select ON public.po_learning_examples;
DROP POLICY IF EXISTS po_learning_examples_insert ON public.po_learning_examples;
DROP POLICY IF EXISTS po_learning_examples_update ON public.po_learning_examples;
CREATE POLICY po_learning_examples_select ON public.po_learning_examples FOR SELECT TO authenticated
  USING (user_can_access_order(auth.uid(), source_order_id));
CREATE POLICY po_learning_examples_insert ON public.po_learning_examples FOR INSERT TO authenticated
  WITH CHECK (approved_by = auth.uid() AND user_can_access_order(auth.uid(), source_order_id));
CREATE POLICY po_learning_examples_update ON public.po_learning_examples FOR UPDATE TO authenticated
  USING (user_can_access_order(auth.uid(), source_order_id))
  WITH CHECK (approved_by = auth.uid() AND user_can_access_order(auth.uid(), source_order_id));

DROP TRIGGER IF EXISTS trg_po_learning_updated_at ON public.po_learning_examples;
CREATE TRIGGER trg_po_learning_updated_at BEFORE UPDATE ON public.po_learning_examples
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
