-- 修复 user_role 枚举：添加缺失的角色值
-- 根据代码使用情况，需要添加：logistics, qc

-- 注意：PostgreSQL 的 ALTER TYPE ADD VALUE 不能在事务块中执行
-- 如果已存在会报错，可以忽略

-- 添加 logistics（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_enum 
    WHERE enumlabel = 'logistics' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ) THEN
    ALTER TYPE user_role ADD VALUE 'logistics';
    RAISE NOTICE 'Added logistics to user_role enum';
  ELSE
    RAISE NOTICE 'logistics already exists in user_role enum';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'logistics already exists (caught exception)';
END $$;

-- 添加 qc（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_enum 
    WHERE enumlabel = 'qc' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ) THEN
    ALTER TYPE user_role ADD VALUE 'qc';
    RAISE NOTICE 'Added qc to user_role enum';
  ELSE
    RAISE NOTICE 'qc already exists in user_role enum';
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'qc already exists (caught exception)';
END $$;

-- 验证：查询所有枚举值
SELECT 
  e.enumlabel as role_value,
  e.enumsortorder as sort_order
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typname = 'user_role'
ORDER BY e.enumsortorder;
