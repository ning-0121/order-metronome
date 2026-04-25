-- ===== 2026-04-25 修复 milestones 无限递归 =====
--
-- 根因：orders_select_v2 直接查询 milestones（非 SECURITY DEFINER），
--       milestones_select_v2 又调用查 orders 的逻辑，形成交叉递归。
--       叠加上次 SQL Editor 手动修复可能留下的残余 policy，触发 PostgreSQL 检测到无限递归。
--
-- 修复策略：
--   1. user_can_access_order() 只查 orders，不查 milestones（消除 SECURITY DEFINER 内的交叉）
--   2. milestones_select_v2：直接检查 owner_user_id OR 调用 user_can_access_order()（无交叉引用）
--   3. orders_select_v2：完全移除对 milestones 的直接查询（通过 user_can_see_all_orders + 直接字段匹配）
--   4. 清理所有可能残留的旧策略

-- ════════════════════════════════════════════════
-- Step 1: 重建 user_can_access_order()
--         移除对 milestones 的查询，只保留 orders 检查（SECURITY DEFINER 安全查询）
-- ════════════════════════════════════════════════

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
    );
$$;

-- ════════════════════════════════════════════════
-- Step 2: 清理 milestones 的所有 SELECT policies（含手动添加的残余）
-- ════════════════════════════════════════════════

DROP POLICY IF EXISTS "milestones_select"    ON public.milestones;
DROP POLICY IF EXISTS "milestones_select_v2" ON public.milestones;
DROP POLICY IF EXISTS "milestones_select_v3" ON public.milestones;
DROP POLICY IF EXISTS "milestones_select_all" ON public.milestones;
DROP POLICY IF EXISTS "milestones_open"      ON public.milestones;

-- ════════════════════════════════════════════════
-- Step 3: 重建 milestones SELECT policy
--         owner_user_id 直接匹配（无需查其他表）
--         OR user_can_access_order()（SECURITY DEFINER，只查 orders，无递归）
-- ════════════════════════════════════════════════

CREATE POLICY "milestones_select_v2" ON public.milestones
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL AND (
      owner_user_id = auth.uid()
      OR public.user_can_access_order(auth.uid(), order_id)
    )
  );

-- ════════════════════════════════════════════════
-- Step 4: 清理 orders 的所有 SELECT policies
-- ════════════════════════════════════════════════

DROP POLICY IF EXISTS "orders_select_all"  ON public.orders;
DROP POLICY IF EXISTS "orders_select_own"  ON public.orders;
DROP POLICY IF EXISTS "orders_select_v2"   ON public.orders;
DROP POLICY IF EXISTS "orders_select_v3"   ON public.orders;

-- ════════════════════════════════════════════════
-- Step 5: 重建 orders SELECT policy
--         移除对 milestones 的直接子查询（消除交叉引用根源）
--         milestone owner 通过 milestones_select_v2 已能访问里程碑数据
-- ════════════════════════════════════════════════

CREATE POLICY "orders_select_v2" ON public.orders
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL AND (
      public.user_can_see_all_orders(auth.uid())
      OR created_by   = auth.uid()
      OR owner_user_id = auth.uid()
    )
  );

-- ════════════════════════════════════════════════
-- 验证：执行以下查询确认策略已正确创建
-- SELECT policyname, cmd, qual FROM pg_policies WHERE tablename IN ('orders', 'milestones') ORDER BY tablename, policyname;
-- ════════════════════════════════════════════════
