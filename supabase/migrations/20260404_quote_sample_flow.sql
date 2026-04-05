-- ===== 2026-04-04 报价 + 打样流程 =====

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_purpose text DEFAULT 'production'
  CHECK (order_purpose IN ('inquiry', 'sample', 'production'));
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parent_order_id uuid REFERENCES public.orders(id);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS sample_status text
  CHECK (sample_status IN ('pending', 'making', 'sent', 'approved', 'rejected'));
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS product_description text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS target_price text;

CREATE INDEX IF NOT EXISTS idx_orders_order_purpose ON public.orders(order_purpose);
CREATE INDEX IF NOT EXISTS idx_orders_parent_order_id ON public.orders(parent_order_id);
