-- ========================================================================
-- 订单明细录入留痕:order_line_items 补 created_by(2026-07-03 用户要求"东西是谁录的")
-- ========================================================================
-- 明细是采购需求的源头,此前没记录录入人。纯加法;存量行留空(历史无从考)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS created_by uuid;

COMMENT ON COLUMN public.order_line_items.created_by IS '录入人(保存明细时写入;整单替换式保存=最后保存人)';

-- 验证(期望 1 行 created_by | uuid):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name='order_line_items' AND column_name='created_by';

-- 回滚:
-- ALTER TABLE public.order_line_items DROP COLUMN IF EXISTS created_by;
