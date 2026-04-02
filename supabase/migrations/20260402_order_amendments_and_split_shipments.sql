-- ===== 2026-04-02 订单修改申请 + 分批出货 =====

-- 1. 订单修改申请表
CREATE TABLE IF NOT EXISTS public.order_amendments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  fields_to_change jsonb NOT NULL DEFAULT '{}',
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  admin_note text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.order_amendments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "order_amendments_authenticated" ON public.order_amendments
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_order_amendments_order_id ON public.order_amendments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_amendments_status ON public.order_amendments(status);

-- 2. 分批出货表
CREATE TABLE IF NOT EXISTS public.shipment_batches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  batch_no integer NOT NULL DEFAULT 1,
  quantity integer NOT NULL DEFAULT 0,
  quantity_unit text DEFAULT 'pcs',
  etd date,
  actual_ship_date date,
  bl_number text,
  vessel_name text,
  tracking_no text,
  notes text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'shipped', 'delivered', 'cancelled')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(order_id, batch_no)
);

ALTER TABLE public.shipment_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shipment_batches_authenticated" ON public.shipment_batches
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_shipment_batches_order_id ON public.shipment_batches(order_id);

-- 3. 订单表增加分批出货标记
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_split_shipment boolean DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_batches integer DEFAULT 1;
