-- ===== 20260611 patch1: matter_type 允许 overdue_summary =====
-- 背景：首轮 dry_run 显示节点级 overdue 产生 313 条 Matter 淹没 CEO 看板，
-- 改为按客户聚合（matter_type='overdue_summary'，每客户最多一条，明细进 evidence）。
-- 原 CHECK 不含 overdue_summary，execute 会被约束拒绝 → 本 patch 扩展取值。
-- 幂等，可安全重复执行。须在第一次 execute 之前运行。

ALTER TABLE public.customer_matters
  DROP CONSTRAINT IF EXISTS customer_matters_matter_type_check;
ALTER TABLE public.customer_matters
  ADD CONSTRAINT customer_matters_matter_type_check
  CHECK (matter_type IN ('suspected_complaint','delivery_risk','overdue','overdue_summary'));
