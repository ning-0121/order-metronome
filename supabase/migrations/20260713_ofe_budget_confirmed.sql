-- ============================================================
-- order_finance_events.event_type 加 'budget.confirmed'
-- 财务侧本周新增 budget.confirmed 回传(=完成PO审批,开绮陌采购硬闸门),
-- 但本表 event_type CHECK(20260704)只允许 settlement.closed/collection.received/
-- payment.completed → 每条 budget.confirmed insert 都违约 500。这是财务进度回传
-- 全军覆没(order_finance_events 恒0行)、硬闸门永不放行的第三重根因(前两重已在代码修)。
-- 可加可逆。
-- ============================================================
ALTER TABLE public.order_finance_events DROP CONSTRAINT IF EXISTS order_finance_events_event_type_check;
ALTER TABLE public.order_finance_events ADD CONSTRAINT order_finance_events_event_type_check
  CHECK (event_type IN ('settlement.closed','collection.received','payment.completed','budget.confirmed'));

-- 验证：
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='order_finance_events_event_type_check';
