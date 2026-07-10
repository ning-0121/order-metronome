-- ============================================================
-- 20260710 物料「客供」标记 —— 客供主料(来料加工)
-- 场景:客户直接供布(绮陌不出钱买),绮陌只自购辅料 + 出加工费。
-- 勾了客供的物料:照录规格/用量(生产任务单要),但绮陌不采购 → 不进采购归并/执行、
-- 不进财务应付、财务面料成本不计。辅料/加工照旧。
-- 排除逻辑在 app 层:procurement-items.ts 归并跳过 + quote-baseline 面料预算跳过。
-- 纯加法可逆列,down 见同名 .down.sql。
-- ============================================================

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS customer_supplied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.materials_bom.customer_supplied IS
  '客供料(来料加工):true=客户供、绮陌不采购(不进采购/应付/面料成本),仅保留规格用量给生产。默认 false。';
