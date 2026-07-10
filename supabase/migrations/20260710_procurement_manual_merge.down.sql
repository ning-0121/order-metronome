-- 回滚 20260710_procurement_manual_merge.sql
ALTER TABLE public.order_cost_baseline
  DROP COLUMN IF EXISTS consolidation_merges;
