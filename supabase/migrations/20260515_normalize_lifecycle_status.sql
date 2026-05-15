-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — 全库归一化 orders.lifecycle_status
--
-- 背景：历史上 OverdueOrderGate 早期版本、人工 SQL、finance-callback 等
--      多处写入了中文枚举（'已完成' / '已取消' / '已归档'），与英文枚举
--      （'completed' / 'cancelled' / 'archived'）混存。
--      不同代码路径对枚举的过滤覆盖不完整，导致已出货订单仍出现在逾期视图。
--
-- 本迁移：把所有中文 lifecycle_status 改成英文枚举，并记录审计日志。
--
-- 不影响：
--   - 不修改任何 milestones.status（保留 ghost 节点，admin 可在
--     /risk-orders/overdue?ghost=1 排查）
--   - 不修改 retrospective 相关字段
--   - 不删除任何记录
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. 归一化 '已完成' → 'completed' ─────────────────────────────────
WITH affected AS (
  UPDATE public.orders
  SET lifecycle_status = 'completed'
  WHERE lifecycle_status = '已完成'
  RETURNING id, order_no
)
INSERT INTO public.order_logs (order_id, actor_id, action, field_name, old_value, new_value, note)
SELECT
  id,
  NULL,                          -- 系统操作（无具体 actor）
  'lifecycle_normalize',
  'lifecycle_status',
  '已完成',
  'completed',
  '[系统迁移 2026-05-15] 中英文枚举归一化'
FROM affected;

-- ─── 2. 归一化 '已取消' → 'cancelled' ────────────────────────────────
WITH affected AS (
  UPDATE public.orders
  SET lifecycle_status = 'cancelled'
  WHERE lifecycle_status = '已取消'
  RETURNING id, order_no
)
INSERT INTO public.order_logs (order_id, actor_id, action, field_name, old_value, new_value, note)
SELECT
  id,
  NULL,
  'lifecycle_normalize',
  'lifecycle_status',
  '已取消',
  'cancelled',
  '[系统迁移 2026-05-15] 中英文枚举归一化'
FROM affected;

-- ─── 3. 归一化 '已归档' → 'archived' ─────────────────────────────────
WITH affected AS (
  UPDATE public.orders
  SET lifecycle_status = 'archived'
  WHERE lifecycle_status = '已归档'
  RETURNING id, order_no
)
INSERT INTO public.order_logs (order_id, actor_id, action, field_name, old_value, new_value, note)
SELECT
  id,
  NULL,
  'lifecycle_normalize',
  'lifecycle_status',
  '已归档',
  'archived',
  '[系统迁移 2026-05-15] 中英文枚举归一化'
FROM affected;

-- ─── 4. 归一化 '执行中' → 'active'（如有）────────────────────────────
-- 早期数据可能存在此中文 active 状态
WITH affected AS (
  UPDATE public.orders
  SET lifecycle_status = 'active'
  WHERE lifecycle_status = '执行中'
  RETURNING id, order_no
)
INSERT INTO public.order_logs (order_id, actor_id, action, field_name, old_value, new_value, note)
SELECT
  id,
  NULL,
  'lifecycle_normalize',
  'lifecycle_status',
  '执行中',
  'active',
  '[系统迁移 2026-05-15] 中英文枚举归一化'
FROM affected;

-- ─── 5. 审计：列出归一化结果摘要 ─────────────────────────────────────
-- 执行后可手动跑此查询验证：
--   SELECT lifecycle_status, COUNT(*) FROM public.orders GROUP BY lifecycle_status ORDER BY 1;
-- 期望结果：只包含 active / completed / cancelled / archived / draft / pending_approval

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 验证 SQL（迁移后手动跑）
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 确认无中文枚举残留：
--    SELECT lifecycle_status, COUNT(*) FROM public.orders GROUP BY lifecycle_status ORDER BY 1;
--
-- 2. 确认审计日志生成：
--    SELECT old_value, new_value, COUNT(*) FROM public.order_logs
--    WHERE action = 'lifecycle_normalize' GROUP BY old_value, new_value;
--
-- 3. 排查残留 ghost 订单（已完成但有未完成里程碑）：
--    SELECT o.order_no, o.lifecycle_status, COUNT(m.id) AS unfinished_milestones
--    FROM orders o
--    JOIN milestones m ON m.order_id = o.id
--    WHERE o.lifecycle_status IN ('completed','cancelled','archived')
--      AND m.status NOT IN ('done','已完成')
--    GROUP BY o.order_no, o.lifecycle_status
--    HAVING COUNT(m.id) > 0
--    ORDER BY unfinished_milestones DESC;
