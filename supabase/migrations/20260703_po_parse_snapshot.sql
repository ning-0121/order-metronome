-- ========================================================================
-- PO 原始识别冻结底档(建单时 AI 解析原文,供后续纠错追溯)
-- ========================================================================
-- 需求:上传 PO 建单时,把 AI 最初识别出来的原文冻结存到订单上。
--   业务后续改的是 order_line_items(工作/纠正版);此列存的是 AI 原文(只读底档)。
--   订单详情可「AI 原始识别 vs 现在的逐款明细」对比,看当初读错在哪。
--   po_parse_snapshot_at = 冻结时间;可被「用当前明细覆盖冻结」按钮更新(再冻结)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS po_parse_snapshot     jsonb,
  ADD COLUMN IF NOT EXISTS po_parse_snapshot_at  timestamptz;

COMMENT ON COLUMN public.orders.po_parse_snapshot IS
  'AI 解析 PO 的原文冻结(建单时);只读底档,纠错追溯用。工作版在 order_line_items';

-- ========================================================================
-- 验证(期望:返回 2 行 po_parse_snapshot|jsonb 和 po_parse_snapshot_at|timestamp with time zone)
-- ========================================================================
-- select column_name, data_type from information_schema.columns
--  where table_name='orders' and column_name like 'po_parse_snapshot%';

-- ========================================================================
-- 回滚
-- ========================================================================
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS po_parse_snapshot,
--   DROP COLUMN IF EXISTS po_parse_snapshot_at;
