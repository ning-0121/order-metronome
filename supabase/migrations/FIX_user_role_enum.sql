-- 修复 user_role 枚举类型：添加缺失的角色值
-- 数据库枚举缺少 'logistics'，代码中使用了 'qc' 但数据库是 'quality'

-- 方法1：添加新值到现有枚举（推荐）
-- PostgreSQL 不支持直接添加枚举值，需要先创建新类型，然后迁移数据

-- 创建新的枚举类型（包含所有需要的值）
DO $$
BEGIN
  -- 检查枚举类型是否已存在新值
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_enum 
    WHERE enumlabel = 'logistics' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ) THEN
    -- 添加 'logistics' 到枚举
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'logistics';
    RAISE NOTICE 'Added logistics to user_role enum';
  ELSE
    RAISE NOTICE 'logistics already exists in user_role enum';
  END IF;
  
  -- 检查 'qc' 是否存在，如果不存在，可能需要将 'quality' 重命名或添加 'qc'
  -- 但 PostgreSQL 不支持重命名枚举值，所以我们需要添加 'qc' 作为别名
  -- 或者修改代码使用 'quality'
  -- 这里我们添加 'qc' 作为新值
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_enum 
    WHERE enumlabel = 'qc' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ) THEN
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'qc';
    RAISE NOTICE 'Added qc to user_role enum';
  ELSE
    RAISE NOTICE 'qc already exists in user_role enum';
  END IF;
END $$;

-- 验证枚举值
SELECT enumlabel 
FROM pg_enum 
WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
ORDER BY enumsortorder;
