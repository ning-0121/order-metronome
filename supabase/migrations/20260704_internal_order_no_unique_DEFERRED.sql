-- ========================================================================
-- 内部单号唯一约束(2026-07-04 审计)—— ⚠️ 延后执行,勿现在跑!
-- ========================================================================
-- 背景:internal_order_no 无唯一约束 → "进行中导入/重导" 撞号,财务按内部号对账串单。
-- 应用层守卫已上线(createOrder / updateOrderField 建单/改号即查重),此索引为 DB 层双保险。
--
-- ⚠️ 执行前提:必须先清完所有活跃订单里的重复内部单号(2026-07-04 已清 2 组
--   cancelled 废单;剩 5 组 EHL 重导 pair + 1022839×4 待业务周一确认后清)。
--   有残留重复时本索引会创建失败。
--
-- 先跑这条预检,必须返回 0 行才可建索引:
--   SELECT internal_order_no, count(*)
--   FROM public.orders
--   WHERE internal_order_no IS NOT NULL
--     AND lifecycle_status NOT IN ('cancelled','已取消','archived','已归档')
--   GROUP BY internal_order_no HAVING count(*) > 1;
--
-- 预检 0 行后,建【部分唯一索引】(只约束活跃订单;cancelled/archived 的历史废单/
-- 带"-已取消"后缀的不参与,避免误伤存档):
-- ========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS orders_internal_order_no_active_uidx
  ON public.orders (internal_order_no)
  WHERE internal_order_no IS NOT NULL
    AND lifecycle_status NOT IN ('cancelled', '已取消', 'archived', '已归档');

-- ========================================================================
-- 验证:SELECT indexname FROM pg_indexes WHERE indexname='orders_internal_order_no_active_uidx';
-- 回滚:DROP INDEX public.orders_internal_order_no_active_uidx;
-- ========================================================================
