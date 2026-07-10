-- ============================================================
-- 20260710 采购项手动合并 —— 同物料不同单位/键 的采购项人工合并
-- 场景:多款单里同一辅料(主标/洗标等)因单位录得不一致(米 vs 个)没被自动归并,
-- 拆成两条。采购人工选「同物料」两条 → 合并成一条(防呆:不同物料不给合并)。
-- 合并需持久化,否则重新核料归并按 BOM 键又拆开。
-- 存法:order_cost_baseline.consolidation_merges = [{from,to}](源归并键 → 目标归并键);
-- 归并(consolidateOrderProcurementItems)计算每行归并键后按此表重映射 → 两键归一 → 永久合并。
-- 纯加法可逆列,down 见同名 .down.sql。
-- ============================================================

ALTER TABLE public.order_cost_baseline
  ADD COLUMN IF NOT EXISTS consolidation_merges jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.order_cost_baseline.consolidation_merges IS
  '采购项人工合并映射 [{from,to}]:源 consolidation_key → 目标 consolidation_key;归并时重映射键使两条永久并一条。仅同物料可合并(app 层防呆)。';
