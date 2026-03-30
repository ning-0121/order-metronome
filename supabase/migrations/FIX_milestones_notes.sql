-- 修复 milestones 表：添加缺失的 notes 字段
-- 如果表已经存在但没有 notes 字段，需要先添加

-- 检查并添加 notes 字段（如果不存在）
DO $$
BEGIN
  -- 检查 notes 列是否存在
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestones' 
    AND column_name = 'notes'
  ) THEN
    -- 添加 notes 字段
    ALTER TABLE public.milestones
    ADD COLUMN notes text;
    
    RAISE NOTICE 'notes 字段已添加到 milestones 表';
  ELSE
    RAISE NOTICE 'notes 字段已存在，跳过';
  END IF;
END $$;

-- 验证字段已添加
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'milestones'
AND column_name = 'notes';
