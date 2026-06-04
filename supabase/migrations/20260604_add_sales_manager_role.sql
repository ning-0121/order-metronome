-- ════════════════════════════════════════════════
-- [2026-06-04] 新增角色：业务部经理 sales_manager
-- ════════════════════════════════════════════════
-- 权限画像（代码层 lib/domain/roles.ts ROLE_GROUPS 已配套）：
--   - 看所有订单（本文件 user_can_see_all_orders 放行）
--   - 改派订单/节点负责人、看金额利润、看销售目标、审批延期、审批价格
--   - 不操作里程碑节点、不绕过付款门禁、非系统管理员
--
-- ⚠️ 执行顺序：本迁移需在 Supabase SQL Editor 手动执行。
-- ⚠️ 若 profiles.role / roles 使用 user_role 枚举，必须先加枚举值，
--    否则在用户管理里给人分配「业务部经理」会写库失败。

-- 1) 若存在 user_role 枚举，补充 'sales_manager' 值（幂等）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'user_role' AND e.enumlabel = 'sales_manager'
    ) THEN
      ALTER TYPE public.user_role ADD VALUE 'sales_manager';
    END IF;
  END IF;
END
$$;

-- 2) 让业务部经理可看所有订单（加入 user_can_see_all_orders 白名单）
CREATE OR REPLACE FUNCTION public.user_can_see_all_orders(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- 注意：role 是 user_role enum，必须 ::text 转换；roles 类型可能是 text[] 或 user_role[]
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = uid
        AND (
          role::text = ANY(ARRAY['admin', 'finance', 'admin_assistant', 'production_manager', 'sales_manager'])
          OR (roles IS NOT NULL AND roles::text[] && ARRAY['admin', 'finance', 'admin_assistant', 'production_manager', 'sales_manager'])
        )
    ),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_can_see_all_orders(uuid) TO authenticated;
