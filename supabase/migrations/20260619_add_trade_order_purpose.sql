-- ===== 20260619 order_purpose 扩展:新增 'trade'(采购成品/经销单)=====
-- 背景:trade order MVP。order_purpose 现 CHECK 约束 IN ('inquiry','sample','production')
--   (来自 20260404_quote_sample_flow.sql 的内联列级 CHECK,自动命名)。新增 'trade'。
-- 仅扩展 CHECK,不改默认值('production' 不变)、不动任何现有行(存量全是 production/sample)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。

-- 第一步:查实约束名(内联自动命名,生产实名以此为准,通常是 orders_order_purpose_check)
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.orders'::regclass AND contype = 'c'
--     AND pg_get_constraintdef(oid) ILIKE '%order_purpose%';

-- 第二步:把上面查到的实名替换到下方 DROP(若与默认名不同),再执行:
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_purpose_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_purpose_check
  CHECK (order_purpose IN ('inquiry', 'sample', 'production', 'trade'));

-- 验证:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid='public.orders'::regclass AND conname='orders_order_purpose_check';
--   -- 应包含 'trade'
