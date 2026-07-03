-- ========================================================================
-- 按款核定大货单耗(2026-07-03 用户拍板:归并取"代表单耗"折算是错的)
-- ========================================================================
-- 正确口径:同一块布不同款的大货单耗不同 → 必须 每款件数 × 该款大货单耗
-- 逐行乘再加总;不填好每个单款的大货单耗,不允许归并。
--   ① materials_bom.production_consumption:采购按 款×色×料 行核定的大货单耗
--     (qty_per_piece=业务的开发单耗,保留只读;两列并存,谁的口径谁负责)
--   ② material_requirements.pieces_qty:该需求行的件数基数(MRP 时写入,
--     归并层用它做精确乘法,不再从净需求反推)
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS production_consumption numeric;
COMMENT ON COLUMN public.materials_bom.production_consumption IS
  '大货单耗(采购按款核定;布料不核定不能归并)。qty_per_piece=开发单耗(业务),两列并存。';

ALTER TABLE public.material_requirements
  ADD COLUMN IF NOT EXISTS pieces_qty numeric;
COMMENT ON COLUMN public.material_requirements.pieces_qty IS
  '该行件数基数(款×色);归并层 总需求=Σ(pieces_qty×该行大货单耗) 的精确乘法用';

-- 验证(期望 2 行):
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE (table_name='materials_bom' AND column_name='production_consumption')
--     OR (table_name='material_requirements' AND column_name='pieces_qty');

-- 回滚:
-- ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS production_consumption;
-- ALTER TABLE public.material_requirements DROP COLUMN IF EXISTS pieces_qty;
