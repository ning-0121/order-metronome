-- ========================================================================
-- 客户加单(2026-07-11)—— 改单携带增量逐款明细
-- ========================================================================
-- 客户加单本就有明确的款/色/码/量。原改单模型只存表头标量(quantity→新值),丢了 SKU 明细,
-- 导致工厂/PI/物料需求据旧明细出错。改法:改单可携带 line_items_delta(增量行),批准时
-- 追加进 order_line_items(独立新行,保批次痕迹),并同步采购(补采购)/财务(应收)/生产。
--
-- 形如:[{"style_no":"SP1567","product_name":"卫衣","color_cn":"黑","color_en":"BLACK",
--        "sizes":{"M":200,"L":100},"po_unit_price":10.6}]
-- 非空 = 该 order_amendments 为「客户加单」;NULL = 普通改单(表头字段)。
-- additive、RLS 不变(order_amendments 的 FOR ALL USING auth.uid() 覆盖)。⚠️ 人工在 Supabase 执行。

ALTER TABLE public.order_amendments
  ADD COLUMN IF NOT EXISTS line_items_delta jsonb;

COMMENT ON COLUMN public.order_amendments.line_items_delta IS
  '客户加单:增量逐款明细 [{style_no,product_name,color_cn,color_en,sizes,po_unit_price}];非空=该改单为客户加单,批准时追加进 order_line_items 并同步采购/财务/生产';

-- ========================================================================
-- 验证(期望 1 行):SELECT column_name FROM information_schema.columns
--   WHERE table_name='order_amendments' AND column_name='line_items_delta';
-- 回滚:ALTER TABLE public.order_amendments DROP COLUMN line_items_delta;
-- ========================================================================
