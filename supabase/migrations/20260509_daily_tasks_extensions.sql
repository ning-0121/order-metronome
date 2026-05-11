-- ===== 2026-05-09 daily_tasks 扩展：missing_info / decision_required 类型 =====

-- 1. 放宽 task_type 约束，增加两个新类型
--    missing_info     — 订单缺失关键信息（工厂日期/财务数据/确认资料）
--    decision_required — 需要人工决策的事项（待审批但超时/无人处理的风险）
ALTER TABLE public.daily_tasks
  DROP CONSTRAINT IF EXISTS daily_tasks_task_type_check;

ALTER TABLE public.daily_tasks
  ADD CONSTRAINT daily_tasks_task_type_check
  CHECK (task_type IN (
    'milestone_overdue',
    'milestone_due_today',
    'customer_followup',
    'delay_approval',
    'quote_approval',
    'profit_warning',
    'system_alert',
    'email_action',
    'missing_info',
    'decision_required'
  ));

-- 2. 给 order_retrospectives 补充「最终利润」和「客户满意度」字段
ALTER TABLE public.order_retrospectives
  ADD COLUMN IF NOT EXISTS final_margin_pct numeric(5,2),          -- 最终实际利润率（来自 profit_snapshots.final）
  ADD COLUMN IF NOT EXISTS customer_satisfaction int                 -- 客户满意度 1-5（主观评分）
    CHECK (customer_satisfaction IS NULL OR customer_satisfaction BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS factory_rating int                        -- 本单工厂评分 1-5
    CHECK (factory_rating IS NULL OR factory_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS will_repeat_customer boolean,             -- 是否会再次下单
  ADD COLUMN IF NOT EXISTS will_repeat_factory boolean;              -- 是否继续用该工厂
