-- ===== 2026-07-24 原辅料到货验收 责任人回填 =====
-- 用户:原辅料到货验收(materials_received_inspected)没分配责任人 —— 应归业务执行,谁建单谁是责任人。
-- 此前该节点 owner_role 走生产/未在业务执行固定集,建单时常没人认领 → 在途老单显示「责任人:未分配」。
-- 回填:把在途单里该节点 owner_user_id 为空的,归业务执行(merchandiser)+ 指派给建单人(owner_user_id ?? created_by)。
-- 只动 owner_user_id 为空的,不覆盖已手动指派的;已解决/取消的单不动。幂等,可重复执行。

update public.milestones m
set owner_user_id = coalesce(o.owner_user_id, o.created_by),
    owner_role   = 'merchandiser',
    updated_at   = now()
from public.orders o
where m.order_id = o.id
  and m.step_key = 'materials_received_inspected'
  and m.owner_user_id is null
  and coalesce(o.owner_user_id, o.created_by) is not null;
