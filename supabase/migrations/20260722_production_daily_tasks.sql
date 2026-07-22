-- ============================================================
-- 2026-07-22 生产今日工作台 · 第2步:daily_tasks 扩充生产任务类型
-- 给生产跟单的今日待办新增 7 种 task_type,直接复用现有 daily_tasks /
-- /my-today 今日任务的生成·去重·优先级·读写全套(不新建任务表)。
--   prod_material_chase  催原辅料
--   prod_factory_arrange 安排工厂
--   prod_first_day       首日上线监控
--   prod_mid_qc          中期验货
--   prod_final_qc        尾期验货
--   prod_packing         追踪包装
--   prod_issue           追踪历史生产问题(来源 production_issues,见第3步迁移)
-- 幂等:DROP IF EXISTS + 重建 CHECK。约束名沿用 Postgres 内联 CHECK 自动名。
-- ============================================================

ALTER TABLE public.daily_tasks DROP CONSTRAINT IF EXISTS daily_tasks_task_type_check;

ALTER TABLE public.daily_tasks ADD CONSTRAINT daily_tasks_task_type_check CHECK (task_type IN (
  -- 既有 10 种(勿删,否则历史行违约)
  'milestone_overdue',
  'milestone_due_today',
  'customer_followup',
  'delay_approval',
  'quote_approval',
  'profit_warning',
  'system_alert',
  'email_action',
  'missing_info',
  'decision_required',
  -- 生产今日工作台新增 7 种
  'prod_material_chase',
  'prod_factory_arrange',
  'prod_first_day',
  'prod_mid_qc',
  'prod_final_qc',
  'prod_packing',
  'prod_issue'
));
