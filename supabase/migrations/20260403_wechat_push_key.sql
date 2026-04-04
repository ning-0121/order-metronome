-- ===== 2026-04-03 微信通知 — Server酱 SendKey =====
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS wechat_push_key text;
COMMENT ON COLUMN public.profiles.wechat_push_key IS 'Server酱 SendKey，用于推送微信通知';
