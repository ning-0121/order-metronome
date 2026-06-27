-- ===== 20260627 限制注册:仅 @qimoclothing.com 邮箱可建账号 =====
-- 背景:应用层(validateEmail + middleware)已挡非公司邮箱,但 Supabase 注册 REST 接口
--   用公开 anon key,理论上可绕过页面直接注册。此触发器在数据库层从根上拒绝,绕不过。
-- 影响:只影响"新注册";不影响已有账号、不影响登录流程。@qimoclothing.com 员工自助注册照常。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行(需 postgres 角色,SQL Editor 默认即是)。幂等。

CREATE OR REPLACE FUNCTION public.enforce_company_email_domain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS NULL OR lower(NEW.email) NOT LIKE '%@qimoclothing.com' THEN
    RAISE EXCEPTION '仅允许 @qimoclothing.com 公司邮箱注册（access restricted to company accounts）';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_company_email_domain ON auth.users;
CREATE TRIGGER trg_enforce_company_email_domain
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_company_email_domain();

-- ── 排查:执行后跑这句,看有没有"历史遗留的非公司邮箱账号"需要清理 ──
-- SELECT id, email, created_at FROM auth.users
-- WHERE email IS NULL OR lower(email) NOT LIKE '%@qimoclothing.com'
-- ORDER BY created_at DESC;
--   如有,确认是垃圾账号后再删:DELETE FROM auth.users WHERE id = '<那个id>';
