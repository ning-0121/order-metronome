-- ========================================================================
-- 性能修复 — notifications 索引(占全库 57% 时间,全表扫无索引)
-- ========================================================================
-- 慢查询报告(2026-07-02):
--   ① notifications WHERE type=$1  —— 71万次调用,占 37% DB 时间(存在性检查)
--   ② notifications WHERE user_id AND status ORDER BY created_at —— 14万次,占 20%(导航栏轮询)
-- 加索引后这两条从全表扫 → 索引命中,预期库负载骤降、全站变快。
-- ⚠️ notifications 是高写表 → 用 CREATE INDEX CONCURRENTLY(不锁写)。
--    CONCURRENTLY 不能在事务里跑 → 在 Supabase SQL Editor **一条一条单独执行**(不要一次全选)。
-- ========================================================================

-- 一次只跑这一条:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_type_order
  ON public.notifications (type, related_order_id);

-- 再单独跑这一条:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_status_created
  ON public.notifications (user_id, status, created_at DESC);

-- ========================================================================
-- 验证(执行后单独跑,期望 2 行)
-- ========================================================================
-- SELECT indexname FROM pg_indexes WHERE tablename='notifications'
--   AND indexname IN ('idx_notifications_type_order','idx_notifications_user_status_created');

-- ========================================================================
-- 回滚(纯加法,删索引即可)
-- ========================================================================
-- DROP INDEX CONCURRENTLY IF EXISTS idx_notifications_type_order;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_notifications_user_status_created;
