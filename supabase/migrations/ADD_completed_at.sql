-- ============================================================
-- KPI 支持：milestones 新增 completed_at 字段
-- 记录节点实际完成时间，用于计算准时率等 KPI
-- ============================================================

-- 1. 新增字段
ALTER TABLE public.milestones
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- 2. 回填：从 milestone_logs 中提取已完成节点的完成时间
UPDATE public.milestones m
SET completed_at = (
  SELECT ml.created_at
  FROM public.milestone_logs ml
  WHERE ml.milestone_id = m.id
    AND ml.to_status = '已完成'
  ORDER BY ml.created_at DESC
  LIMIT 1
)
WHERE m.status = '已完成'
  AND m.completed_at IS NULL;

-- 3. 没有日志记录的已完成节点，用 updated_at 兜底
UPDATE public.milestones
SET completed_at = updated_at
WHERE status = '已完成'
  AND completed_at IS NULL;
