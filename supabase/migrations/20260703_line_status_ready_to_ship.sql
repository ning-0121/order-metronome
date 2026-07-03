-- ========================================================================
-- 采购行状态 + 「已完成待送货」(ready_to_ship)
-- ========================================================================
-- 用户需求:采购中心队列细分为 待下单 / 待催货(生产中) / 已完成待送货(在途) / 已送达待验收,
--   并逐行显示未到货数量。现有枚举缺"工厂已完成、尚未发货"这一档 → 新增 ready_to_ship。
-- 流转:ordered/confirmed/in_production → ready_to_ship → shipped → arrived(代码侧状态机同步)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

ALTER TABLE public.procurement_line_items
  DROP CONSTRAINT IF EXISTS procurement_line_items_line_status_check;

ALTER TABLE public.procurement_line_items
  ADD CONSTRAINT procurement_line_items_line_status_check
  CHECK (line_status IN ('draft','pending_order','ordered','confirmed',
                         'in_production','ready_to_ship','shipped','arrived',
                         'accepted','concession','rejected','closed','cancelled'));

-- ========================================================================
-- 验证(期望:constraint 定义里包含 ready_to_ship)
-- ========================================================================
-- select pg_get_constraintdef(oid) from pg_constraint
--  where conname = 'procurement_line_items_line_status_check';

-- ========================================================================
-- 回滚(先确认没有行已使用 ready_to_ship)
-- ========================================================================
-- ALTER TABLE public.procurement_line_items DROP CONSTRAINT procurement_line_items_line_status_check;
-- ALTER TABLE public.procurement_line_items ADD CONSTRAINT procurement_line_items_line_status_check
--   CHECK (line_status IN ('draft','pending_order','ordered','confirmed','in_production','shipped','arrived','accepted','concession','rejected','closed','cancelled'));
