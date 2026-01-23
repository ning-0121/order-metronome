-- 修复 milestone_logs 表：添加缺失的 order_id 字段
-- 如果表已经存在但没有 order_id 字段，需要先添加

-- 检查并添加 order_id 字段（如果不存在）
DO $$
BEGIN
  -- 检查 order_id 列是否存在
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'order_id'
  ) THEN
    -- 添加 order_id 字段
    ALTER TABLE public.milestone_logs
    ADD COLUMN order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE;
    
    -- 从 milestones 表填充 order_id（如果可能）
    UPDATE public.milestone_logs ml
    SET order_id = m.order_id
    FROM public.milestones m
    WHERE ml.milestone_id = m.id
    AND ml.order_id IS NULL;
    
    -- 将 order_id 设为 NOT NULL（如果所有记录都有值）
    -- 注意：如果有些记录的 order_id 为 NULL，这一步会失败
    -- 如果失败，需要手动处理这些记录
    BEGIN
      ALTER TABLE public.milestone_logs
      ALTER COLUMN order_id SET NOT NULL;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE '无法将 order_id 设为 NOT NULL，因为存在 NULL 值。请手动处理。';
    END;
  END IF;
  
  -- 检查并重命名 actor_id 为 actor_user_id（如果存在）
  IF EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'actor_id'
  ) AND NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'actor_user_id'
  ) THEN
    ALTER TABLE public.milestone_logs
    RENAME COLUMN actor_id TO actor_user_id;
  END IF;
  
  -- 检查并重命名 previous_status 为 from_status（如果存在）
  IF EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'previous_status'
  ) AND NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'from_status'
  ) THEN
    ALTER TABLE public.milestone_logs
    RENAME COLUMN previous_status TO from_status;
  END IF;
  
  -- 检查并重命名 new_status 为 to_status（如果存在）
  IF EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'new_status'
  ) AND NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'milestone_logs' 
    AND column_name = 'to_status'
  ) THEN
    ALTER TABLE public.milestone_logs
    RENAME COLUMN new_status TO to_status;
  END IF;
END $$;

-- 创建 order_id 索引（如果不存在）
CREATE INDEX IF NOT EXISTS idx_milestone_logs_order_id ON public.milestone_logs(order_id);

-- 重新创建 RLS 策略（使用正确的字段名）
DROP POLICY IF EXISTS "milestone_logs_select_own" ON public.milestone_logs;
CREATE POLICY "milestone_logs_select_own" ON public.milestone_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = milestone_logs.order_id
      AND orders.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "milestone_logs_insert_authenticated" ON public.milestone_logs;
CREATE POLICY "milestone_logs_insert_authenticated" ON public.milestone_logs
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = milestone_logs.order_id
      AND orders.created_by = auth.uid()
    )
  );
