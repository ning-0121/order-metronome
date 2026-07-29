-- 线下补录标签(2026-07-29 CEO 线下采购补录规划①):建单时勾选,列表/详情/财务侧一眼识别补录单。幂等。
alter table public.purchase_orders add column if not exists offline_backfill boolean default false;
comment on column public.purchase_orders.offline_backfill is '线下补录采购单(事后补进系统);推财务 payload 同名字段带出';
