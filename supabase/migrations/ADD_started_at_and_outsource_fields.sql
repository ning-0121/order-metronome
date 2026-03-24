-- ============================================================
-- 1. milestones 新增 started_at（节点开始执行时间）
-- ============================================================
ALTER TABLE public.milestones
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- 回填：进行中/已完成的节点，用 updated_at 兜底
UPDATE public.milestones
SET started_at = updated_at
WHERE started_at IS NULL
  AND status IN ('进行中', '已完成');

-- ============================================================
-- 2. outsource_jobs 新增三个生产计划字段
-- ============================================================
ALTER TABLE public.outsource_jobs
  ADD COLUMN IF NOT EXISTS expected_workers integer,
  ADD COLUMN IF NOT EXISTS expected_start_date date,
  ADD COLUMN IF NOT EXISTS expected_end_date date;
