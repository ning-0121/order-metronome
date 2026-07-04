-- ========================================================================
-- 堵自助提权(2026-07-04 全 OS 审计 P0):profiles.roles[] 数组不受提权守卫
-- ========================================================================
-- 原 guard_profiles_role_update 只拦标量 NEW.role,不拦后加的 roles[] 数组。
-- 而全站权限判定优先读 roles[](getUserRoles/hasRoleInGroup)。加上
-- profiles_update_own_basic 允许用户改自己的行 → 任意登录用户可直连 PostgREST
--   UPDATE profiles SET roles='{admin}' WHERE user_id=<自己>
-- 自助提权为 admin。本补丁把 roles[] 也纳入守卫。
--
-- 安全性验证:合法管理员改角色走 app/actions/users.ts updateUserRoles,用
--   **管理员自己的 session**(auth.uid()=admin)且同时写 role+roles →
--   is_admin_user(admin)=true 仍放行;service-role/后台路径同理不受影响。
--   攻击者(非 admin)只改 roles[] → is_admin_user(self)=false → 拒。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

CREATE OR REPLACE FUNCTION public.guard_profiles_role_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 标量 role 或 数组 roles 任一发生变化,都必须是 admin 才允许
  IF (NEW.role IS DISTINCT FROM OLD.role)
     OR (NEW.roles IS DISTINCT FROM OLD.roles) THEN
    IF NOT public.is_admin_user(auth.uid()) THEN
      RAISE EXCEPTION 'only admin can update role/roles';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 触发器已存在(trg_guard_profiles_role_update BEFORE UPDATE),CREATE OR REPLACE
-- FUNCTION 原地替换函数体即生效;此处防御性重建以确保挂接。
DROP TRIGGER IF EXISTS trg_guard_profiles_role_update ON public.profiles;
CREATE TRIGGER trg_guard_profiles_role_update
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.guard_profiles_role_update();

-- ========================================================================
-- 验证(执行后):
-- 用非 admin 账号(user session)直连尝试自助提权,应报 "only admin can update role/roles":
--   UPDATE public.profiles SET roles = ARRAY['admin'] WHERE user_id = auth.uid();
-- 用 admin 账号经"用户管理"改他人角色,应正常成功。
-- ========================================================================
-- 回滚:重跑 supabase/migration.sql 第 681-701 段(仅拦标量 role 的旧版本)。
-- ========================================================================
