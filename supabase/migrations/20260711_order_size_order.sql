-- ===== 2026-07-11 订单级尺码列显式顺序(business 手排逃生口)=====
-- 背景:自动排序认不出怪尺码系统(如巴西码 P/M/G = Pequeno/Médio/Grande,应 P→M→G,
--   自动排把 M 当标准码排最前 → 排成 M,G,P 错)。给业务在富录入表「尺码列」手拖排序,
--   持久化到订单级,下游(生产任务单/PI/采购/出货)全部按此顺序,不再各自自动排。
-- 口径:jsonb 数组,元素为尺码标签字符串(如 ["P","M","G"]);为空/NULL 时回落标准自动序。
--   订单级单一真相源(富录入表所有款共用一套尺码列,与编辑器模型一致)。

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS size_order jsonb;

COMMENT ON COLUMN public.orders.size_order IS
  '尺码列显式顺序(业务在富录入表手排);jsonb 字符串数组如 ["P","M","G"];NULL=回落标准自动排序';

-- 验证(期望返回 1 行:size_order | jsonb）
-- select column_name, data_type from information_schema.columns
--  where table_name='orders' and column_name='size_order';

-- 回滚:
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS size_order;
