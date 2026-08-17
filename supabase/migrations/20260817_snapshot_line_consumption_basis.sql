-- ========================================================================
-- 物料包快照行冻结「用量口径」(2026-08-17)
--
-- 背景:MRP 算采购需求读的是 material_package_snapshot_lines(提交时冻结的 BOM 快照),
--   但这张表**从来没有 consumption_basis 列** —— 于是:
--   ① 跟单在 BOM 上确认的口径,提交采购时被丢掉;
--   ② mrp.ts 只能硬写死 'PER_SET' 来算(2026-08-17 同批修正);
--   ③ 结果「确认口径」这个动作对采购数量毫无影响,BomTab 显示与 MRP 各算各的。
--
-- 快照的意义是**冻结当时的业务真相**。单耗冻结了、口径没冻结,
--   那这份快照就还原不出当初那个数字 —— 等于没冻结。
--
-- 实证(1022967 / QM-20260714-005,quantity_unit='三件套'):
--   面料单耗 0.53(每件口径)→ 正确需求 0.53×2400=1272kg;
--   口径丢失后按 PER_SET 算 → 商业数量 2400÷3=800 → 0.53×800=424kg。
--   业务实际拿到的是 424,少算约 2/3。
--
-- NULL = 未确认 → mrp.ts 沿用历史 PER_SET,在途订单行为不变(全库 182/185 行本就为空,
--   一刀切改成 needs_input 会让所有单当场卡住)。
--
-- 纯加法,幂等。
-- ========================================================================

ALTER TABLE public.material_package_snapshot_lines
  ADD COLUMN IF NOT EXISTS consumption_basis text;

COMMENT ON COLUMN public.material_package_snapshot_lines.consumption_basis IS
  '提交采购时冻结的用量口径(PER_SET/PER_PIECE/PER_COMPONENT/PER_ORDER),来自 materials_bom.consumption_basis。NULL=未确认,MRP 沿用历史 PER_SET。快照要能还原当初那个数字,单耗和口径必须一起冻。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='material_package_snapshot_lines' AND column_name='consumption_basis';  -- 期望 1 行
-- 回滚:ALTER TABLE public.material_package_snapshot_lines DROP COLUMN IF EXISTS consumption_basis;
-- ========================================================================
