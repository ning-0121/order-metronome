-- ===== [2026-07-06] 分批出货按款色分配(剩余货物精确到每款每色)=====
-- 现状:shipment_batches 只记每批总件数,算不出"每款每色还剩多少"。
-- 加 shipment_batch_items:记"某批出了某个 order_line_item(款+色)多少件"。
-- 剩余(每款色)= order_line_items.qty_pcs − Σ(已出货/已交付批次的该行分配件数)。

CREATE TABLE IF NOT EXISTS public.shipment_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.shipment_batches(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  order_line_item_id uuid REFERENCES public.order_line_items(id) ON DELETE CASCADE,
  qty_pcs int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sbi_batch ON public.shipment_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_sbi_order ON public.shipment_batch_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sbi_line ON public.shipment_batch_items(order_line_item_id);

ALTER TABLE public.shipment_batch_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sbi_authenticated ON public.shipment_batch_items FOR ALL USING (auth.uid() IS NOT NULL);

-- 回滚:DROP TABLE IF EXISTS public.shipment_batch_items;
