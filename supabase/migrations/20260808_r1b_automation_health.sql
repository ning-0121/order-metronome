-- R1-B Automation Health(2026-08-08)
--
-- ① automation_runs 通用化:补齐执行契约字段(所有 Cron/Agent/CEO Delegation 复用)
-- ② notifications.payload:order-audit 每天把审计详情塞 payload,该列生产从未存在,
--    插入失败 73 天被吞 —— 这是"通知停发"的直接根因(命名核对:代码里就叫 payload,
--    与任何现有列不冲突,jsonb)

alter table public.automation_runs add column if not exists trigger_type text;          -- cron/manual/retry/system
alter table public.automation_runs add column if not exists duration_ms integer;
alter table public.automation_runs add column if not exists rows_updated integer;
alter table public.automation_runs add column if not exists rows_deleted integer;
alter table public.automation_runs add column if not exists eligible_items integer;
alter table public.automation_runs add column if not exists processed_items integer;
alter table public.automation_runs add column if not exists failed_items integer;
alter table public.automation_runs add column if not exists skipped_items integer;
alter table public.automation_runs add column if not exists started_by text;            -- cron / 用户id
alter table public.automation_runs add column if not exists parent_run_id uuid;
alter table public.automation_runs add column if not exists retry_of_run_id uuid;

alter table public.notifications add column if not exists payload jsonb;

comment on column public.notifications.payload is
  '结构化附加数据(如 order-audit 的问题清单)。2026-08-08 补:此列缺失曾让每日审计通知静默停发 73 天。';
