-- ===== 2026-07-24 临时调货(裁片 / 半成品 工厂间临时调拨)=====
-- 场景:A 厂机器坏 / 产能不足,把裁片或半成品临时挪到 B 厂救急,记来源单 / 调出厂 / 调入厂 / 数量 + 归还。
-- 纯加法(新表),不影响现有外发 outsource_jobs。
-- 回滚:drop table if exists public.production_transfers;

create table if not exists public.production_transfers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  from_factory text not null,             -- 调出厂(A)
  to_factory text not null,               -- 调入厂(B)
  item_desc text not null,                -- 调的什么(裁片/半成品,如「LU21 黑色 前片」)
  qty numeric not null,                   -- 数量
  unit text default '件',                 -- 单位(件/扎/包…)
  reason text,                            -- 调货原因(A厂机器坏 / 产能不足…)
  transfer_date date,                     -- 调出日期
  expected_return_date date,              -- 预计归还
  actual_return_date date,                -- 实际归还
  status text not null default 'out',     -- out 已调出(在B厂)/ returned 已归还A厂 / consumed 并入B厂大货(不还,两厂结算)
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_production_transfers_order on public.production_transfers(order_id);

comment on table public.production_transfers is
  '临时调货:裁片/半成品在工厂间临时调拨(A厂救急→B厂),记来源单/调出厂/调入厂/数量+归还。与外发 outsource_jobs 区分:那是本单发给某厂加工,这是两厂间临时挪货。';

-- RLS:与 outsource_jobs 同口径 —— 已登录用户可读写,角色门禁在 server action(requireRoleGroup EXECUTION)里挡。
alter table public.production_transfers enable row level security;
drop policy if exists pt_all on public.production_transfers;
create policy pt_all on public.production_transfers
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.production_transfers to authenticated;
