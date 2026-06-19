-- ===== 20260619 性能索引：最热的过滤/join 列 =====
-- 审计(2026-06-19)发现以下列被 CEO/dashboard/briefing/cron/采购队列 等高频用于
-- .in()/.eq()/.lt() 过滤与 join，但 migrations 里从无索引（PG 不会为 FK 列自动建索引）。
-- 纯加索引，幂等(IF NOT EXISTS)，零回滚风险。在 Supabase SQL Editor 执行。
-- 大表上建议用 CONCURRENTLY；但 CONCURRENTLY 不能在事务/迁移块里跑，这里用普通 CREATE，
-- 表量级中等、瞬时完成。若线上表已很大，可改为手动 CREATE INDEX CONCURRENTLY 单独执行。

-- milestones：每订单 ~20 行，所有订单详情/看板 join 都按 order_id；看板按 due_at/status 筛超期
CREATE INDEX IF NOT EXISTS idx_milestones_order_id ON public.milestones(order_id);
CREATE INDEX IF NOT EXISTS idx_milestones_due_at   ON public.milestones(due_at);
CREATE INDEX IF NOT EXISTS idx_milestones_order_status ON public.milestones(order_id, status);
CREATE INDEX IF NOT EXISTS idx_milestones_owner_user  ON public.milestones(owner_user_id);

-- orders：列表/看板/cron 按 lifecycle_status 过滤；按 owner_user_id 看"我的订单"
CREATE INDEX IF NOT EXISTS idx_orders_lifecycle_status ON public.orders(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_orders_owner_user_id    ON public.orders(owner_user_id);

-- delay_requests：待审批中心/CEO 按 status='pending' 筛
CREATE INDEX IF NOT EXISTS idx_delay_requests_status ON public.delay_requests(status);
