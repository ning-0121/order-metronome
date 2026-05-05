-- ===== 2026-05-04 国内送仓订单字段 =====
-- 适用：年年旺这类客户，货物送到客户指定的国内仓库，不报关出运
-- 仅在 delivery_type = 'domestic' 时为必填

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_warehouse_name text,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS delivery_contact text,
  ADD COLUMN IF NOT EXISTS delivery_phone text,
  ADD COLUMN IF NOT EXISTS delivery_required_at date;

COMMENT ON COLUMN public.orders.delivery_warehouse_name IS '客户指定收货仓库名称（如：年年旺嘉兴仓）';
COMMENT ON COLUMN public.orders.delivery_address       IS '收货详细地址';
COMMENT ON COLUMN public.orders.delivery_contact       IS '仓库收货联系人';
COMMENT ON COLUMN public.orders.delivery_phone         IS '联系电话';
COMMENT ON COLUMN public.orders.delivery_required_at   IS '客户要求送达日期（用于重排排期可行性判断）';
