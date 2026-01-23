-- Create attachments table for milestone evidence
CREATE TABLE IF NOT EXISTS public.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id uuid NOT NULL REFERENCES public.milestones(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  url text NOT NULL,
  file_name text,
  file_type text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_attachments_milestone_id ON public.attachments(milestone_id);
CREATE INDEX IF NOT EXISTS idx_attachments_order_id ON public.attachments(order_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_by ON public.attachments(uploaded_by);

-- Enable RLS
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Order owner or admin can select
CREATE POLICY "Order owner or admin can select attachments"
  ON public.attachments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = attachments.order_id
      AND (
        o.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
          AND p.role = 'admin'
        )
      )
    )
  );

-- RLS Policy: Order owner or admin can insert
CREATE POLICY "Order owner or admin can insert attachments"
  ON public.attachments
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = attachments.order_id
      AND (
        o.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
          AND p.role = 'admin'
        )
      )
    )
  );

-- RLS Policy: Order owner or admin can delete
CREATE POLICY "Order owner or admin can delete attachments"
  ON public.attachments
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = attachments.order_id
      AND (
        o.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
          AND p.role = 'admin'
        )
      )
    )
  );

-- Add comment
COMMENT ON TABLE public.attachments IS 'Evidence attachments for milestones. Order owner or admin can manage.';
