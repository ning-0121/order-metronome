-- ============================================================
-- 20260707_bom_pack_size —— 辅料「每包件数」(N件一包)
-- ============================================================
-- 背景:中包袋这类打包辅料,6件一中包 → 需求应是 件数÷6,而非按单件用量×件数。
-- 业务在「原辅料和包装」页给辅料填「每包件数」(6件一中包→6);
-- MRP 需求 = 件数 × 单耗 ÷ 每包件数(空/1 = 不打包,口径不变)。
-- 纯加法;materials_bom(录入)+ material_package_snapshot_lines(冻结)两处都加,冻结时带过去。
-- ============================================================
ALTER TABLE public.materials_bom ADD COLUMN IF NOT EXISTS pack_size numeric;
ALTER TABLE public.material_package_snapshot_lines ADD COLUMN IF NOT EXISTS pack_size numeric;

COMMENT ON COLUMN public.materials_bom.pack_size IS
  '每包件数(N件一包的打包辅料,如中包袋6件一中包→6)。需求=件数×单耗÷每包件数;空或1=不打包。';

-- 验证:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name IN ('materials_bom','material_package_snapshot_lines')
--    AND column_name='pack_size';   → 2 行
-- 回滚:ALTER TABLE public.materials_bom DROP COLUMN IF EXISTS pack_size;
--       ALTER TABLE public.material_package_snapshot_lines DROP COLUMN IF EXISTS pack_size;
