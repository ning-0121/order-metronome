-- ========================================================================
-- procurement_items RLS 收紧(2026-07-04 审计 P0:此前任意登录即可读全库底价)
-- ========================================================================
-- 原 pi_sel/pi_ins/pi_upd/pi_del 全是 auth.uid() IS NOT NULL → 任何登录用户
-- 可直连 select * from procurement_items 拿到全库 unit_price/供应商成交价,
-- 绕过一切页面。收紧为:采购侧角色(user_is_procurement_side)或 能访问该订单
-- 的人(user_can_access_order,创建者/负责人/canSeeAll)。两个函数在
-- 20260703_pli_procurement_access.sql / 20260408_rls_hardening.sql 已建。
-- 底价 unit_price 的列级屏蔽仍由 server action 剥离(RLS 是行级,管不到列)。
-- 业务在订单详情看「采购进度」tab 仍可(能访问自己订单),底价被 action 剥。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

DROP POLICY IF EXISTS pi_sel ON public.procurement_items;
CREATE POLICY pi_sel ON public.procurement_items FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id))
);

DROP POLICY IF EXISTS pi_ins ON public.procurement_items;
CREATE POLICY pi_ins ON public.procurement_items FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id))
);

DROP POLICY IF EXISTS pi_upd ON public.procurement_items;
CREATE POLICY pi_upd ON public.procurement_items FOR UPDATE
USING (
  auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id))
);

-- 删除仅采购侧(20260703_delete_policies_fix 的 pi_del 太宽,收紧)
DROP POLICY IF EXISTS pi_del ON public.procurement_items;
CREATE POLICY pi_del ON public.procurement_items FOR DELETE
USING (auth.uid() IS NOT NULL AND public.user_is_procurement_side(auth.uid()));

-- ========================================================================
-- 验证(期望 4 行,且都不再是 auth.uid()宽策略):
-- SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy
--  WHERE polrelid='public.procurement_items'::regclass;
-- 用非采购、非订单负责人的账号直查该表 → 应查不到不属于自己的订单的采购项。
-- ========================================================================
-- 回滚:重跑 20260628_p1_procurement_items.sql 的策略段 + delete_policies_fix 的 pi_del
