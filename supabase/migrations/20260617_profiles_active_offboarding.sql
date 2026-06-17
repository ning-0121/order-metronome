-- ===== 20260617 离职功能：profiles 软停用列（离职按钮）=====
-- 背景：离职 = 转派活跃工作 + 封锁登录(ban auth) + 移出花名册。
--   软停用而非硬删 → 保留 name，历史节点 owner 仍能显示姓名；零外键连锁；可逆。
--   详见 docs/offboarding-sop.md。本迁移仅加列 + 索引，幂等，无数据破坏。
-- 在 Supabase SQL Editor 执行（部署前/部署时立即执行，additive 列瞬时完成）。
-- 注意：代码侧 getAllUsers / admin/users 页对缺列做了降级容错，即使迁移晚一步也不至于白屏，
--   但「离职/恢复」功能依赖这些列，请尽快执行本迁移。

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS departed_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS handover_to uuid;  -- 离职时活跃工作转派给谁（审计；不加 FK 避免外键连锁）

COMMENT ON COLUMN public.profiles.active IS '是否在职。false=已离职（软停用）：从指派人选择器与默认用户列表过滤；登录由 auth ban 封锁。';
COMMENT ON COLUMN public.profiles.departed_at IS '离职时间。';
COMMENT ON COLUMN public.profiles.handover_to IS '离职时活跃工作转派给的用户 id（审计）。';

-- 列表与选择器频繁按 active 过滤
CREATE INDEX IF NOT EXISTS idx_profiles_active ON public.profiles(active);
