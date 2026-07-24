-- ===== 2026-07-24 外发裁剪 / 裁片交货工厂 =====
-- 外发裁剪(裁床)job_type + 裁片交货至哪个车缝厂(裁片流转)。纯加法,不 brick 现有外发。
ALTER TABLE public.outsource_jobs
  ADD COLUMN IF NOT EXISTS deliver_to_factory text;   -- 裁片交货至(车缝厂);仅外发裁剪用
