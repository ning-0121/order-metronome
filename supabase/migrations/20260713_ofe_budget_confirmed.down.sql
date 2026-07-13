-- 回滚(需先清 budget.confirmed 行否则加约束失败)
ALTER TABLE public.order_finance_events DROP CONSTRAINT IF EXISTS order_finance_events_event_type_check;
ALTER TABLE public.order_finance_events ADD CONSTRAINT order_finance_events_event_type_check
  CHECK (event_type IN ('settlement.closed','collection.received','payment.completed'));
