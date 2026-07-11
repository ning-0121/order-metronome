-- ============================================================
-- 异色套装 —— order_line_items 加套装组标记 set_group_no
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- ------------------------------------------------------------
-- 背景:有的客户按「一件(衣架/套)」统计报价,实际一套=两件不同颜色(如一黑一藏青),同码。
--   建单按「套」录:一款开「异色套装」→ 填一次尺码配比 → 加两色 → 系统展开成 黑/藏青 两条明细行。
--   两条组件行用同一 set_group_no 绑定为一套:
--     · 生产/采购看到分色件数(黑100+藏青100=200件,native);
--     · 套数 = 组件行 qty(100);orders.quantity = 总件数(200);
--     · 套价存主组件(第一色 po_unit_price=套价,其余为空)→ 应收 Σ(单价×件数)=套数×套价,零涟漪。
-- 性质:纯加法,单列(可空,普通单为空)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。幂等。
-- ============================================================

ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS set_group_no text;

CREATE INDEX IF NOT EXISTS idx_oli_set_group ON public.order_line_items(order_id, set_group_no);

COMMENT ON COLUMN public.order_line_items.set_group_no IS
  '异色套装:同一套的组件行(不同颜色)共享同一 set_group_no。非空=套装组件;套价存组内主组件(第一色)po_unit_price,其余为空。套数=组件行qty,总件数=组件数×套数。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 在 Supabase SQL Editor 单独运行；本文件不自动执行）
-- ------------------------------------------------------------
-- [1] 列存在(期望 1 行, text, YES)
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_line_items' AND column_name='set_group_no';
--
-- [2] 索引存在(期望 1 行 idx_oli_set_group)
-- SELECT indexname FROM pg_indexes WHERE tablename='order_line_items' AND indexname='idx_oli_set_group';
--
-- [3] 老数据全空(期望 non_null=0)
-- SELECT count(set_group_no) AS non_null FROM public.order_line_items;
-- ============================================================
