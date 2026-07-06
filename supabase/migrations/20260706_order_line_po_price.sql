-- ============================================================
-- 20260706_order_line_po_price —— 客户 PO 逐款成交单价(给客户的价)
-- ============================================================
-- 背景:此前系统里"给客户的价"处处取自内部报价单(报价基线 selling_price_per_piece),
--   但客户实际下单价可能被我们让利压低 → 应以【PO 价】为准。
-- 口径:每款一个单价(用户 2026-07-06 拍板);AI 从客户 PO 解析 → 人在录入表确认 → 保存即冻结。
-- 可见性:客户成交价属财务口径,仅 CAN_SEE_FINANCIALS(admin/finance/sales/sales_manager/order_manager)
--   可读,server 端剥离(非 UI 隐藏);生产/QC/物流看生产任务单时不含此列。
-- 纯加法。
-- ============================================================
ALTER TABLE public.order_line_items ADD COLUMN IF NOT EXISTS po_unit_price numeric;

COMMENT ON COLUMN public.order_line_items.po_unit_price IS
  '客户PO逐款成交单价(给客户的价,可能低于我们报价)。AI解析客户PO→人确认→保存即冻结。仅CAN_SEE_FINANCIALS可读,server端剥离。';

-- 验证:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='order_line_items' AND column_name='po_unit_price';  → 1 行
-- 回滚:ALTER TABLE public.order_line_items DROP COLUMN IF EXISTS po_unit_price;
