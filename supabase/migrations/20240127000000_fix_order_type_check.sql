-- ===== 2026-03-24: 修复 order_type CHECK 约束 — 加入 'repeat' =====
-- 问题：表单允许选 '翻单(repeat)' 但 DB CHECK 只允许 sample/bulk
-- 导致创建订单时 INSERT 失败但前端未显示错误

-- 1. 删除旧的 CHECK 约束
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;

-- 2. 添加新的 CHECK 约束（包含 repeat）
ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('sample', 'bulk', 'repeat'));

-- 3. 确保 order_date 列存在（代码依赖但未见 migration）
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_date date;

-- 4. 确保 customer_id 列存在
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_id uuid;
