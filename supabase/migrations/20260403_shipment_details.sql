-- ===== 2026-04-03 出货管理完善 — 新增出货详情字段 =====

-- 出货申请详情（业务填写）
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS delivery_address text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS delivery_method text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS shipping_port text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS destination_port text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS ci_number text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS requested_ship_date date;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS requested_by uuid;

-- 财务审批信息
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS finance_decision text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS finance_decision_note text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS payment_status text;

-- 物流执行信息
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS actual_ship_date date;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS container_no text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS logistics_note text;
ALTER TABLE public.shipment_confirmations ADD COLUMN IF NOT EXISTS delivery_proof_url text;
