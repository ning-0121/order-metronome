-- ========================================================================
-- S1.2 每款布料信息 + BOM 按款分组
-- ========================================================================
-- 业务事实:布料是「款」的属性。富录入表每款录 布料名/门幅/单耗 →
--   ① 自动同步成该款 BOM 第一行(materials_bom, source='line_items_sync')
--   ② 生产任务单「用料单耗」按款带出
--   ③ BOM 按 style_no 分组,每款下可继续加辅料;提交采购/核料归并不变
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

-- 逐款明细:每款布料字段(款级属性,同款各颜色行同值,取首个非空——与 image_url 同模式)
ALTER TABLE public.order_line_items
  ADD COLUMN IF NOT EXISTS fabric_name        text,      -- 布料名(如 280g 仿锦)
  ADD COLUMN IF NOT EXISTS fabric_width       text,      -- 门幅(如 150cm)
  ADD COLUMN IF NOT EXISTS fabric_consumption numeric,   -- 单耗/件(数字)
  ADD COLUMN IF NOT EXISTS fabric_unit        text;      -- 单耗单位(kg/米/平方)

-- BOM:款号维度(NULL = 整单通用;既有行不受影响)
ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS style_no text;

-- ========================================================================
-- 验证(期望:两条查询分别返回 4 行和 1 行)
-- ========================================================================
-- select column_name from information_schema.columns
--  where table_name = 'order_line_items' and column_name like 'fabric%';
-- select column_name from information_schema.columns
--  where table_name = 'materials_bom' and column_name = 'style_no';

-- ========================================================================
-- 回滚
-- ========================================================================
-- ALTER TABLE public.order_line_items DROP COLUMN IF EXISTS fabric_name,
--   DROP COLUMN IF EXISTS fabric_width, DROP COLUMN IF EXISTS fabric_consumption,
--   DROP COLUMN IF EXISTS fabric_unit;
-- ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS style_no;
