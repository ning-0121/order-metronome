-- 行车路径 / 出车行程 + 捎带共享(2026-07-27 CEO)
-- 按日程规划出车路径,共享到系统,方便别人帮带东西到生产单位/工厂。
-- 幂等。

create table if not exists public.factory_trips (
  id uuid primary key default gen_random_uuid(),
  trip_date date not null,
  created_by uuid references auth.users(id),
  creator_name text,
  factory_ids uuid[] not null default '{}',   -- 本次要跑的工厂(有序=路线顺序)
  note text,
  status text not null default 'planned',      -- planned / done / cancelled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_factory_trips_date on public.factory_trips (trip_date desc);

create table if not exists public.trip_piggyback (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.factory_trips(id) on delete cascade,
  requester_id uuid references auth.users(id),
  requester_name text,
  item text not null,                          -- 要带什么
  to_factory_id uuid,                          -- 带到哪家工厂(可空=随行程)
  to_factory_name text,
  note text,
  status text not null default 'requested',    -- requested / accepted / done / cancelled
  created_at timestamptz not null default now()
);
create index if not exists idx_trip_piggyback_trip on public.trip_piggyback (trip_id);

-- RLS:登录用户可读写(内部协作工具;写操作 action 里再按需校验)
alter table public.factory_trips enable row level security;
alter table public.trip_piggyback enable row level security;
drop policy if exists factory_trips_all on public.factory_trips;
create policy factory_trips_all on public.factory_trips for all to authenticated using (true) with check (true);
drop policy if exists trip_piggyback_all on public.trip_piggyback;
create policy trip_piggyback_all on public.trip_piggyback for all to authenticated using (true) with check (true);
