-- ===== 2026-04-29 Decision Escalation: add escalate_count to daily_tasks =====
ALTER TABLE public.daily_tasks
  ADD COLUMN IF NOT EXISTS escalate_count int NOT NULL DEFAULT 0;
