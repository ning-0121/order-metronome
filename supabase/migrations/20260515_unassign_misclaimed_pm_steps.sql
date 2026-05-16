-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-15 — 清除生产主管固定节点的误认领
--
-- 背景：bulk_materials_confirmed / processing_fee_confirmed / factory_confirmed
--      / pre_production_sample_ready 这 4 个节点理论上只属于生产主管（秦增富）。
--      历史上当秦增富未匹配时，节点 owner_user_id=null，被业务/跟单访问时
--      触发自动认领（canModify 跨组允许），导致这些节点出现在业务的"我的逾期"。
--
-- 修复：把 owner_role='production_manager' 但 owner_user_id 是非 PM 用户的
--      已认领节点 unassign（设回 null），由 admin 重新指定。
--      不影响节点状态（status 保留），不影响订单。
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

WITH misclaimed AS (
  SELECT m.id, m.step_key, m.owner_user_id, p.name AS claimed_by_name, p.email AS claimed_by_email
  FROM public.milestones m
  LEFT JOIN public.profiles p ON p.user_id = m.owner_user_id
  WHERE m.step_key IN (
          'bulk_materials_confirmed',
          'processing_fee_confirmed',
          'factory_confirmed',
          'pre_production_sample_ready'
        )
    AND m.owner_user_id IS NOT NULL
    -- 排除真正的生产主管（roles 包含 production_manager 或 role='production_manager'）
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles pp
      WHERE pp.user_id = m.owner_user_id
        AND (
          pp.role = 'production_manager'
          OR 'production_manager' = ANY(COALESCE(pp.roles, ARRAY[]::text[]))
        )
    )
),
unassigned AS (
  UPDATE public.milestones
  SET owner_user_id = NULL
  WHERE id IN (SELECT id FROM misclaimed)
  RETURNING id, order_id, step_key
)
INSERT INTO public.milestone_logs (milestone_id, order_id, actor_user_id, action, note)
SELECT
  u.id, u.order_id, NULL, 'pm_misclaim_cleanup',
  '[系统迁移 2026-05-15] 生产主管固定节点被非 PM 用户错误认领，自动 unassign'
FROM unassigned u;

COMMIT;
