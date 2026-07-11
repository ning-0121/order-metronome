-- ===== 2026-07-11 收货批次加「收货地址」+ 收货对账单导出 =====
-- 分批收货表单已支持:数量/日期/码单附件(photos jsonb 存 order-docs 路径)。
-- 新增 received_address:每批收货填收货地址,导出《收货对账单》时按行显示,和供应商对账。
ALTER TABLE public.goods_receipts
  ADD COLUMN IF NOT EXISTS received_address text;

COMMENT ON COLUMN public.goods_receipts.received_address IS
  '本批收货地址(采购收货时填,导出收货对账单按行显示;历史批次为空)。';
