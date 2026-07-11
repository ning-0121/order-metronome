-- ============================================================
-- user_can_see_all_orders 补 order_manager / procurement_manager
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-11
-- ------------------------------------------------------------
-- 背景/根因:orders RLS(orders_select_v2)用 DB 函数 user_can_see_all_orders 判定谁能看所有订单。
--   该函数上次(20260604)只补到 sales_manager,**漏了 order_manager**。
--   → 业务执行经理(高洁 order_manager)在 app 逻辑里算"看所有订单"(roles.ts CAN_SEE_ALL_ORDERS 含它),
--     但 DB RLS 不认 → 她只能打开自己创建/负责的订单。别人订单她**打不开** → 看不到延期面板/去审批按钮
--     → 待审批中心/工作台能看到(那两处走 service-role 绕过 RLS),点进订单却 notFound,"没办法操作"。
-- 修:把函数角色清单对齐 app 层 CAN_SEE_ALL_ORDERS(补 order_manager + procurement_manager)。
-- 性质:CREATE OR REPLACE 纯函数替换,无数据变更,幂等。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ============================================================

CREATE OR REPLACE FUNCTION public.user_can_see_all_orders(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- role 是 user_role enum → ::text;roles 是 text[]/user_role[] → 统一 text[]
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = uid
        AND (
          role::text = ANY(ARRAY['admin','finance','admin_assistant','production_manager','sales_manager','order_manager','procurement_manager'])
          OR (roles IS NOT NULL AND roles::text[] && ARRAY['admin','finance','admin_assistant','production_manager','sales_manager','order_manager','procurement_manager'])
        )
    ),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_can_see_all_orders(uuid) TO authenticated;

-- ============================================================
-- 验证(执行后,在 SQL Editor 跑;把 uid 换成高洁的 user_id 852a518c-ebe6-4b2d-8f20-606283348592):
--   SELECT public.user_can_see_all_orders('852a518c-ebe6-4b2d-8f20-606283348592');  -- 期望 true
-- ============================================================
