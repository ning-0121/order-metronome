-- ============================================================
-- 多角色支持：profiles.roles text[] 字段
-- 解决一个用户需要同时拥有多个角色的问题（如 Helen = 理单 + 采购）
-- ============================================================

-- 1. 新增 roles 数组字段
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS roles text[] NOT NULL DEFAULT '{}';

-- 2. 将旧 role 单值迁移到 roles 数组（仅对 roles 为空的记录）
UPDATE public.profiles
SET roles = ARRAY[role::text]
WHERE roles = '{}' AND role IS NOT NULL;

-- 3. 更新 RLS 策略：milestones_update 支持多角色
DROP POLICY IF EXISTS "milestones_update" ON public.milestones;
CREATE POLICY "milestones_update" ON public.milestones
  FOR UPDATE USING (
    auth.uid() = owner_user_id
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
      AND (
        owner_role::text = ANY(roles)
        OR 'admin' = ANY(roles)
      )
    )
  );

-- 4. 更新 RLS 策略：delay_requests_select 支持多角色
DROP POLICY IF EXISTS "delay_requests_select" ON public.delay_requests;
CREATE POLICY "delay_requests_select" ON public.delay_requests
  FOR SELECT USING (
    auth.uid() = requested_by
    OR EXISTS (
      SELECT 1 FROM milestones m
      JOIN profiles p ON p.user_id = auth.uid()
      WHERE m.id = delay_requests.milestone_id
      AND (m.owner_user_id = auth.uid() OR 'admin' = ANY(p.roles))
    )
  );

-- 5. 更新 RLS 策略：delay_requests_update 支持多角色
DROP POLICY IF EXISTS "delay_requests_update" ON public.delay_requests;
CREATE POLICY "delay_requests_update" ON public.delay_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM milestones m
      JOIN profiles p ON p.user_id = auth.uid()
      WHERE m.id = delay_requests.milestone_id
      AND (m.owner_user_id = auth.uid() OR 'admin' = ANY(p.roles))
    )
  );
