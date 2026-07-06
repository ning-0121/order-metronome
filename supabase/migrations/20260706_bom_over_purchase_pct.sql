-- ============================================================
-- 20260706_bom_over_purchase_pct —— 逐料抛量%(采购决定多采购多少)
-- 口径(用户 2026-07-06 拍板):大货单耗由业务执行填(技术部大货版);采购在核料页对每种料填「抛量%」,
--   采购量 = Σ(件数 × 大货单耗) × (1 + 抛量%)。抛量是采购职权,逐料可不同。
-- 纯加法:materials_bom 加一列,默认 0。
-- ============================================================

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS over_purchase_pct numeric DEFAULT 0;

COMMENT ON COLUMN public.materials_bom.over_purchase_pct IS
  '抛量%(采购填):采购量在 件数×大货单耗 基础上多采购的百分比。默认0。';

-- ── 验证(手动)──
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='materials_bom' AND column_name='over_purchase_pct';  → 1 行
