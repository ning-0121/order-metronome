-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — Ghost Milestone Heal
--
-- 背景：orders.ts STEP 9 的「过期已发货」路径历史上有 try/catch{} 静默吞错。
--      Supabase await 不抛异常只返回 {error}，导致 milestone update 失败
--      时 lifecycle_status 仍被设为 'completed'，留下 ghost：
--        - 订单 lifecycle = 'completed' / '已完成'
--        - 部分 milestone.status 仍 = 'pending' / 未 done
--      → 财务/生产视图持续显示逾期
--      → 业务想标完被 checkOrderModifiable 拦截（"订单已完成"）
--      → 死循环
--
-- 修复（已在 main 代码层）：orders.ts 显式检查 error，失败时不再误标 completed。
-- 本迁移：清洗历史数据 — 把已完成订单的所有未完成节点一次性标完。
--
-- 不影响：
--   - 进行中订单（lifecycle='active' 等）不受影响
--   - 不修改 lifecycle_status
--   - 仅修改 status != 'done' 的节点为 'done'
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

WITH ghost_targets AS (
  -- 找出"订单已完成 OR 已归档"但节点未标完的 milestone
  -- lifecycle 用归一化后的英文值；如未跑 normalize 迁移，也兼容中文枚举
  SELECT m.id, m.order_id, o.order_no, m.step_key, m.status
  FROM public.milestones m
  JOIN public.orders o ON o.id = m.order_id
  WHERE o.lifecycle_status IN ('completed', 'archived', '已完成', '已归档')
    AND COALESCE(m.status, '') NOT IN ('done', '已完成', 'completed')
),
updated AS (
  UPDATE public.milestones
  SET
    status = 'done',
    actual_at = COALESCE(actual_at, now())
  WHERE id IN (SELECT id FROM ghost_targets)
  RETURNING id, order_id, step_key, status
)
-- 写审计日志
INSERT INTO public.milestone_logs (milestone_id, order_id, actor_user_id, action, note)
SELECT
  u.id, u.order_id, NULL, 'auto_heal_ghost',
  '[系统迁移 2026-05-15] 订单已完成但节点未标完，系统自动标完 — heal ghost milestone'
FROM updated u;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 验证 SQL（迁移后手动跑）
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 确认无 ghost 残留：
--    SELECT o.order_no, o.lifecycle_status, COUNT(m.id) AS unfinished
--    FROM orders o
--    JOIN milestones m ON m.order_id = o.id
--    WHERE o.lifecycle_status IN ('completed','cancelled','archived','已完成','已取消','已归档')
--      AND m.status NOT IN ('done','已完成','completed')
--    GROUP BY o.order_no, o.lifecycle_status
--    HAVING COUNT(m.id) > 0;
--    （期望返回 0 行 — 已取消的订单不在 heal 范围内，会保留；
--     如想顺带 heal cancelled，参考下方扩展 SQL）
--
-- 2. 查 heal 数量（审计日志统计）：
--    SELECT COUNT(*) FROM milestone_logs WHERE action='auto_heal_ghost';
--
-- 3. （可选）扩展：连 cancelled 订单的未完成节点也 heal：
--    （cancelled 订单通常会留 milestone 不动作为审计痕迹，是否 heal 看业务策略）
--    BEGIN;
--    UPDATE milestones SET status='done', actual_at=COALESCE(actual_at, now())
--    WHERE order_id IN (
--      SELECT id FROM orders WHERE lifecycle_status IN ('cancelled','已取消')
--    ) AND COALESCE(status, '') NOT IN ('done','已完成','completed');
--    COMMIT;
