-- ===== 2026-04-06 邮件线索追踪 — 追溯订单沟通起源 =====

-- 增加邮件线索追踪字段
ALTER TABLE public.mail_inbox
  ADD COLUMN IF NOT EXISTS message_id text,         -- 邮件唯一标识 (Message-ID header)
  ADD COLUMN IF NOT EXISTS in_reply_to text,        -- 回复的邮件 (In-Reply-To header)
  ADD COLUMN IF NOT EXISTS thread_id text,           -- 对话线索ID（同一主题线）
  ADD COLUMN IF NOT EXISTS is_thread_start boolean DEFAULT false;  -- 是否是对话首封邮件

-- 索引：加速线索查询
CREATE INDEX IF NOT EXISTS idx_mail_inbox_thread_id ON public.mail_inbox(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_inbox_message_id ON public.mail_inbox(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_inbox_from_email ON public.mail_inbox(from_email);

-- 追加到 migration.sql
