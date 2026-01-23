-- Order Metronome V1.6: 订单生命周期管理
-- 订单出生→执行→终结→复盘 全链路封死

-- =========================
-- B1: orders 表新增字段
-- =========================

alter table public.orders
add column if not exists lifecycle_status text not null default '草稿'
  check (lifecycle_status in ('草稿','已生效','执行中','已完成','已取消','待复盘','已复盘'));

alter table public.orders
add column if not exists activated_at timestamptz null;

alter table public.orders
add column if not exists terminated_at timestamptz null;

alter table public.orders
add column if not exists termination_type text null
  check (termination_type is null or termination_type in ('完成','取消'));

alter table public.orders
add column if not exists termination_reason text null;

alter table public.orders
add column if not exists termination_approved_by uuid null
  references auth.users(id);

alter table public.orders
add column if not exists retrospective_required boolean not null default true;

alter table public.orders
add column if not exists retrospective_completed_at timestamptz null;

-- 约束：若 lifecycle_status ∈ ('已完成','已取消','待复盘','已复盘') 则 terminated_at not null
alter table public.orders
add constraint check_terminated_at_not_null
check (
  (lifecycle_status in ('已完成','已取消','待复盘','已复盘') and terminated_at is not null)
  or
  (lifecycle_status not in ('已完成','已取消','待复盘','已复盘'))
);

-- 约束：若 termination_type='取消' 则 termination_reason not null
alter table public.orders
add constraint check_cancel_reason_not_null
check (
  (termination_type = '取消' and termination_reason is not null)
  or
  (termination_type != '取消' or termination_type is null)
);

-- =========================
-- B2: order_logs 表（订单事件日志）
-- =========================

create table if not exists public.order_logs (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.orders(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  action text not null,
  from_status text null,
  to_status text null,
  note text null,
  payload jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_logs_order_id_created_at 
on public.order_logs(order_id, created_at desc);

-- =========================
-- B3: cancel_requests 表（取消申请与审批）
-- =========================

create table if not exists public.cancel_requests (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.orders(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  reason_type text not null
    check (reason_type in ('customer_cancel','pricing_issue','capacity_issue','risk_control','other')),
  reason_detail text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  decided_by uuid null references auth.users(id),
  decided_at timestamptz null,
  decision_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cancel_requests_order_id on public.cancel_requests(order_id);
create index if not exists idx_cancel_requests_status on public.cancel_requests(status);

-- updated_at trigger
drop trigger if exists trg_cancel_requests_updated_at on public.cancel_requests;
create trigger trg_cancel_requests_updated_at
before update on public.cancel_requests
for each row execute function public.set_updated_at();

-- =========================
-- B4: order_retrospectives 表（复盘）
-- =========================

create table if not exists public.order_retrospectives (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id),
  on_time_delivery boolean null,
  major_delay_reason text null
    check (major_delay_reason is null or major_delay_reason in ('customer','supplier','internal','logistics','other')),
  blocked_count int not null default 0,
  delay_request_count int not null default 0,
  key_issue text not null,
  root_cause text not null,
  what_worked text not null,
  improvement_actions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(improvement_actions) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_order_retrospectives_order_id on public.order_retrospectives(order_id);

-- updated_at trigger
drop trigger if exists trg_order_retrospectives_updated_at on public.order_retrospectives;
create trigger trg_order_retrospectives_updated_at
before update on public.order_retrospectives
for each row execute function public.set_updated_at();

-- =========================
-- B5: RLS 策略
-- =========================

alter table public.order_logs enable row level security;
alter table public.cancel_requests enable row level security;
alter table public.order_retrospectives enable row level security;

-- order_logs: 仅订单owner可查看
drop policy if exists "order_logs_select_own" on public.order_logs;
create policy "order_logs_select_own"
on public.order_logs for select
using (
  exists (
    select 1 from public.orders
    where orders.id = order_logs.order_id
    and orders.created_by = auth.uid()
  )
);

drop policy if exists "order_logs_insert_own" on public.order_logs;
create policy "order_logs_insert_own"
on public.order_logs for insert
with check (
  exists (
    select 1 from public.orders
    where orders.id = order_logs.order_id
    and orders.created_by = auth.uid()
  )
);

-- cancel_requests: 仅订单owner可查看/操作
drop policy if exists "cancel_requests_select_own" on public.cancel_requests;
create policy "cancel_requests_select_own"
on public.cancel_requests for select
using (
  exists (
    select 1 from public.orders
    where orders.id = cancel_requests.order_id
    and orders.created_by = auth.uid()
  )
);

drop policy if exists "cancel_requests_insert_own" on public.cancel_requests;
create policy "cancel_requests_insert_own"
on public.cancel_requests for insert
with check (
  exists (
    select 1 from public.orders
    where orders.id = cancel_requests.order_id
    and orders.created_by = auth.uid()
  )
  and requested_by = auth.uid()
);

drop policy if exists "cancel_requests_update_own" on public.cancel_requests;
create policy "cancel_requests_update_own"
on public.cancel_requests for update
using (
  exists (
    select 1 from public.orders
    where orders.id = cancel_requests.order_id
    and orders.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.orders
    where orders.id = cancel_requests.order_id
    and orders.created_by = auth.uid()
  )
);

-- order_retrospectives: 仅订单owner可查看/操作
drop policy if exists "order_retrospectives_select_own" on public.order_retrospectives;
create policy "order_retrospectives_select_own"
on public.order_retrospectives for select
using (
  exists (
    select 1 from public.orders
    where orders.id = order_retrospectives.order_id
    and orders.created_by = auth.uid()
  )
);

drop policy if exists "order_retrospectives_insert_own" on public.order_retrospectives;
create policy "order_retrospectives_insert_own"
on public.order_retrospectives for insert
with check (
  exists (
    select 1 from public.orders
    where orders.id = order_retrospectives.order_id
    and orders.created_by = auth.uid()
  )
  and owner_user_id = auth.uid()
);

drop policy if exists "order_retrospectives_update_own" on public.order_retrospectives;
create policy "order_retrospectives_update_own"
on public.order_retrospectives for update
using (
  exists (
    select 1 from public.orders
    where orders.id = order_retrospectives.order_id
    and orders.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.orders
    where orders.id = order_retrospectives.order_id
    and orders.created_by = auth.uid()
  )
  and owner_user_id = auth.uid()
);
