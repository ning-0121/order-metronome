-- ===== 2026-04-08 RLS 加固 — orders / milestones / order_attachments =====
--
-- 背景（系统深度自检 P1）：
-- 之前 milestones / order_attachments 的 RLS 都是 `auth.uid() IS NOT NULL`，
-- 任何登录用户都能直连 Supabase 读到全部里程碑和附件。
-- 应用层有过滤，但绕过应用层的代码（client SDK / 第三方工具）都能拿到全量数据。
--
-- 本迁移加 DB 级权限：
--   1. 业务员只能看到自己创建的订单 / 自己负责的订单 / 自己有里程碑的订单
--   2. admin / finance / admin_assistant / production_manager 可看全部
--   3. milestones / order_attachments 跟随 orders 的可见性
--
-- ⚠️ 高风险变更：跑迁移前先备份。如果跑完后业务员看不到自己的订单，
--    立即执行本文件末尾的 ROLLBACK 段落恢复旧策略。

-- ════════════════════════════════════════════════
-- A. Helper functions（SECURITY DEFINER 跳过 RLS 避免递归）
-- ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.user_can_see_all_orders(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = uid
        AND (
          role = ANY(ARRAY['admin', 'finance', 'admin_assistant', 'production_manager'])
          OR roles && ARRAY['admin', 'finance', 'admin_assistant', 'production_manager']
        )
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.user_can_access_order(uid uuid, oid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.user_can_see_all_orders(uid)
    OR EXISTS (
      SELECT 1 FROM public.orders
      WHERE id = oid
        AND (created_by = uid OR owner_user_id = uid)
    )
    OR EXISTS (
      SELECT 1 FROM public.milestones
      WHERE order_id = oid AND owner_user_id = uid
    );
$$;

-- 让所有 authenticated 用户能调用这些 helper
GRANT EXECUTE ON FUNCTION public.user_can_see_all_orders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_access_order(uuid, uuid) TO authenticated;

-- ════════════════════════════════════════════════
-- B. orders SELECT policy 加固
-- ════════════════════════════════════════════════

DROP POLICY IF EXISTS "orders_select_all" ON public.orders;
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
DROP POLICY IF EXISTS "orders_select_v2" ON public.orders;

CREATE POLICY "orders_select_v2" ON public.orders
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL AND (
      public.user_can_see_all_orders(auth.uid())
      OR created_by = auth.uid()
      OR owner_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.milestones
        WHERE order_id = orders.id AND owner_user_id = auth.uid()
      )
    )
  );

-- ════════════════════════════════════════════════
-- C. milestones SELECT policy 加固
-- ════════════════════════════════════════════════

DROP POLICY IF EXISTS "milestones_select" ON public.milestones;
DROP POLICY IF EXISTS "milestones_select_v2" ON public.milestones;

CREATE POLICY "milestones_select_v2" ON public.milestones
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND public.user_can_access_order(auth.uid(), order_id)
  );

-- ════════════════════════════════════════════════
-- D. order_attachments SELECT policy 加固
-- ════════════════════════════════════════════════

DROP POLICY IF EXISTS "order_attachments_select" ON public.order_attachments;
DROP POLICY IF EXISTS "order_attachments_select_v2" ON public.order_attachments;

CREATE POLICY "order_attachments_select_v2" ON public.order_attachments
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND public.user_can_access_order(auth.uid(), order_id)
  );

-- ════════════════════════════════════════════════
-- 注意：UPDATE / INSERT / DELETE policies 保持不变
-- 它们已经通过 Server Action 层做权限校验，并且历史 policy 是按角色限制的
-- ════════════════════════════════════════════════

-- ════════════════════════════════════════════════
-- 回滚方案（如果业务员看不到订单）
-- 把下面 4 个 DROP / CREATE 取消注释执行即可恢复旧策略：
-- ════════════════════════════════════════════════
-- DROP POLICY IF EXISTS "orders_select_v2" ON public.orders;
-- CREATE POLICY "orders_select_all" ON public.orders FOR SELECT USING (
--   auth.uid() = created_by
--   OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
-- );
-- DROP POLICY IF EXISTS "milestones_select_v2" ON public.milestones;
-- CREATE POLICY "milestones_select" ON public.milestones FOR SELECT USING (auth.uid() IS NOT NULL);
-- DROP POLICY IF EXISTS "order_attachments_select_v2" ON public.order_attachments;
-- CREATE POLICY "order_attachments_select" ON public.order_attachments FOR SELECT USING (auth.uid() IS NOT NULL);
