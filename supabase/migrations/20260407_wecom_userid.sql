-- ===== 2026-04-07 企业微信用户ID =====

-- 增加企业微信 userid 字段（用于精准发送应用消息）
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS wecom_userid text;

COMMENT ON COLUMN public.profiles.wecom_userid IS '企业微信 userid，用于发送应用消息';
