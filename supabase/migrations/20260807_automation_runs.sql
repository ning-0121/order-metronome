-- QIMO Reliability Sprint R1 · automation_runs(自动化任务真实健康台账)
--
-- 【为什么】2026-08-07 体检:备份 cron 从未产出过一份文件、/api/cron/daily 四步空转数月、
-- order-audit 通知停发 73 天 —— 全部每天 HTTP 200 绿灯。CRON SUCCESS != HTTP 200,
-- 成功必须按业务结果判定(产出了几个文件?写了几行?),没有台账就没人能发现假健康。
--
-- 本表是 R1-B Automation Health 的地基;R1-A 先用它记备份运行(备份健康检测依赖它)。
-- service-role 写(cron 天然 service-role);authenticated 只读(给未来管理面板)。

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  run_id text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- running / success / degraded / failed
  status text not null default 'running',
  rows_read integer,
  rows_written integer,
  artifacts_created integer,
  notifications_created integer,
  -- 该任务的业务成功底线(如备份:artifacts>=1);不满足即 degraded/failed
  expected_min_output text,
  -- healthy / degraded / failed —— 按业务结果判定,与 HTTP 状态无关
  health_status text,
  error_code text,
  error_message text,
  metadata jsonb
);

create index if not exists idx_automation_runs_job_time
  on public.automation_runs (job_name, started_at desc);

alter table public.automation_runs enable row level security;

drop policy if exists automation_runs_select on public.automation_runs;
create policy automation_runs_select on public.automation_runs
  for select using (auth.uid() is not null);
-- 无 INSERT/UPDATE 策略:只有 service-role(绕过 RLS)可写 —— cron/后台专用

comment on table public.automation_runs is
  'R1-B 自动化健康台账:每次 cron/后台任务一行,按业务产出判健康(CRON SUCCESS != HTTP 200)。2026-08-07';
