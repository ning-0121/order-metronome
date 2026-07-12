-- ===== [2026-07-13] 生产排单 P4:派工进度日志(跟单/QC 每天录实际产出) =====
-- 派工是计划(production_dispatch.planned_qty),本表是实绩:每天录当日完成件数,累计=SUM。
-- append-only:录错不改不删,补一条负数 qty_done 修正(用户口径「输入,修正」)。
-- 写走 service-role(action 内校验生产/跟单/QC/主管角色);读 RLS 放给登录用户。

create table if not exists public.production_dispatch_logs (
  id          uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references public.production_dispatch(id) on delete cascade,
  order_id    uuid,
  log_date    date not null,
  qty_done    integer not null default 0,   -- 当日完成件数(增量;可为负=修正)
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists idx_pdl_dispatch on public.production_dispatch_logs(dispatch_id);
create index if not exists idx_pdl_order    on public.production_dispatch_logs(order_id);

alter table public.production_dispatch_logs enable row level security;
drop policy if exists pdl_select on public.production_dispatch_logs;
create policy pdl_select on public.production_dispatch_logs
  for select using (auth.uid() is not null);
-- 不建 insert/update/delete policy → 仅 service-role 可写(append-only,由 action 把关角色)
