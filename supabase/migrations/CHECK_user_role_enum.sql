-- 步骤1：数据库真相核对

-- 1.1 查询 enum user_role 当前允许的全部值
SELECT e.enumlabel as role_value
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE t.typname='user_role'
ORDER BY e.enumsortorder;

-- 1.2 定位哪些表/列在使用 user_role enum
SELECT 
  n.nspname as schema, 
  c.relname as table_name, 
  a.attname as column_name, 
  t.typname as type_name
FROM pg_attribute a
JOIN pg_class c ON a.attrelid=c.oid
JOIN pg_namespace n ON c.relnamespace=n.oid
JOIN pg_type t ON a.atttypid=t.oid
WHERE t.typname='user_role' 
  AND a.attnum>0 
  AND NOT a.attisdropped
ORDER BY n.nspname, c.relname, a.attname;
