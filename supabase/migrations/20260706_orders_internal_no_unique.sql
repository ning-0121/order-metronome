-- ============================================================
-- 20260706_orders_internal_no_unique —— 内部单号唯一(活跃单)DB 级兜底
-- App 层已在 createOrder / 改内部号 处查重(2026-07-04);此处加 DB 唯一索引双保险,
-- 任何绕过 App 的路径(脚本/直连)也挡住重复。
-- ⚠ 若有历史活跃重复(如 1022869×2),此索引【会创建失败】——请先跑下面的"查重复"SQL 清理,再执行本迁移。
--   查重复:
--   SELECT internal_order_no, count(*), string_agg(order_no, ', ')
--     FROM public.orders
--     WHERE internal_order_no IS NOT NULL
--       AND lifecycle_status NOT IN ('cancelled','已取消','archived','已归档')
--     GROUP BY internal_order_no HAVING count(*) > 1;
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_internal_no_active
  ON public.orders (internal_order_no)
  WHERE internal_order_no IS NOT NULL
    AND lifecycle_status NOT IN ('cancelled', '已取消', 'archived', '已归档');

-- ── 验证 ──
-- SELECT indexname FROM pg_indexes WHERE indexname='uq_orders_internal_no_active';  → 1 行
