-- ========================================================================
-- 采购执行行 RLS:放行采购角色直通(2026-07-03 事故:采购员生成执行行被拒)
-- ========================================================================
-- 根因:pli_select/insert/update 的前置 user_can_access_order 依赖 canSeeAll
--   名单(admin/finance/admin_assistant/production_manager)——采购角色不在其中,
--   订单又是业务建的(创建者/负责人都不是采购) → 采购员操作执行行被 RLS 拒绝
--   ("无权操作此数据"),确认采购后"没有下文"。
-- 修:采购按物料干活,不应被订单可见性拦 —— 三个策略加"采购类角色直通"分支;
--   原 订单创建者/负责人 分支保留。同时把 procurement_manager 补进名单(原漏)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

-- 角色直通判定(采购员/采购经理/理单/管理员)
CREATE OR REPLACE FUNCTION public.user_is_procurement_side(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = uid
      AND (
        role::text = ANY(ARRAY['admin','procurement','procurement_manager','merchandiser'])
        OR (roles IS NOT NULL AND roles::text[] && ARRAY['admin','procurement','procurement_manager','merchandiser'])
      )
  ), false);
$$;
GRANT EXECUTE ON FUNCTION public.user_is_procurement_side(uuid) TO authenticated;

DROP POLICY IF EXISTS "pli_select" ON public.procurement_line_items;
CREATE POLICY "pli_select" ON public.procurement_line_items FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id))
);

DROP POLICY IF EXISTS "pli_insert" ON public.procurement_line_items;
CREATE POLICY "pli_insert" ON public.procurement_line_items FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND (
    public.user_is_procurement_side(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "pli_update" ON public.procurement_line_items;
CREATE POLICY "pli_update" ON public.procurement_line_items FOR UPDATE
USING (
  auth.uid() IS NOT NULL
  AND (
    public.user_is_procurement_side(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- ========================================================================
-- 验证(执行后逐条跑,期望值见注释)
-- ========================================================================
-- ① 期望 1 行(函数在):
-- SELECT proname FROM pg_proc WHERE proname='user_is_procurement_side';
-- ② 期望 3 行(三个策略都在):
-- SELECT polname FROM pg_policy WHERE polrelid='public.procurement_line_items'::regclass
--   AND polname IN ('pli_select','pli_insert','pli_update');
-- ③ 用采购员账号在核料页点「生成执行行」→ 应成功(不再 RLS 拒绝)。

-- ========================================================================
-- 回滚:重跑 20260428_02_create_procurement_line_items.sql 的策略段
-- ========================================================================
