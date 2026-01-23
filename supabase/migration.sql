-- Order Metronome (V1) Database Migration
-- Run this in Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- =========================
-- ENUMS
-- =========================

-- User roles
create type user_role as enum (
  'sales',
  'finance',
  'procurement',
  'production',
  'quality',
  'admin'
);

-- Milestone status
create type milestone_status as enum (
  'pending',
  'in_progress',
  'done',
  'blocked',
  'overdue'
);

-- Delay request status
create type delay_request_status as enum (
  'pending',
  'approved',
  'rejected'
);

-- Notification status
create type notification_status as enum (
  'unread',
  'read'
);

-- =========================
-- TABLES
-- =========================

-- User profiles
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role user_role not null,
  email text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Orders table (V1)
create table if not exists public.orders (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  created_by uuid not null, -- auth.users.id

  customer_name text not null,
  order_no text not null,

  incoterm text not null check (incoterm in ('FOB','DDP')),
  etd date,                 -- required for FOB
  warehouse_due_date date,  -- required for DDP

  order_type text not null check (order_type in ('sample','bulk')),
  packaging_type text not null check (packaging_type in ('standard','custom')),

  -- optional for later
  notes text
);

-- Unique constraint: order_no per workspace/company (V1: per database)
create unique index if not exists idx_orders_order_no on public.orders(order_no);

-- Milestones
create table milestones (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade not null,
  step_key text not null,
  name text not null,
  owner_role user_role not null,
  owner_user_id uuid references auth.users(id),
  planned_at timestamptz not null,
  due_at timestamptz not null,
  status milestone_status default 'pending',
  is_critical boolean default false,
  evidence_required boolean default false,
  watchers uuid[] default '{}', -- Array of user IDs
  sequence_number int not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(order_id, step_key)
);

-- Milestone logs (audit trail)
create table milestone_logs (
  id uuid primary key default uuid_generate_v4(),
  milestone_id uuid references milestones(id) on delete cascade not null,
  actor_id uuid references auth.users(id),
  action text not null,
  note text,
  previous_status milestone_status,
  new_status milestone_status,
  created_at timestamptz default now()
);

-- Delay requests
create table delay_requests (
  id uuid primary key default uuid_generate_v4(),
  milestone_id uuid references milestones(id) on delete cascade not null,
  requested_by uuid references auth.users(id) not null,
  requested_days int not null,
  reason text not null,
  status delay_request_status default 'pending',
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Notifications
create table notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  type text not null, -- 'reminder', 'overdue', 'blocked', 'delay_approved', etc.
  title text not null,
  message text not null,
  related_order_id uuid references orders(id) on delete cascade,
  related_milestone_id uuid references milestones(id) on delete cascade,
  status notification_status default 'unread',
  email_sent boolean default false,
  created_at timestamptz default now()
);

-- Order attachments
create table order_attachments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade not null,
  milestone_id uuid references milestones(id) on delete cascade,
  uploaded_by uuid references auth.users(id) not null,
  file_name text not null,
  file_url text not null,
  file_size bigint,
  mime_type text,
  created_at timestamptz default now()
);

-- =========================
-- INDEXES
-- =========================

create index if not exists idx_orders_created_by on orders(created_by);
create index if not exists idx_milestones_order_id on milestones(order_id);
create index if not exists idx_milestones_owner_user_id on milestones(owner_user_id);
create index if not exists idx_milestones_status on milestones(status);
create index if not exists idx_milestones_due_at on milestones(due_at);
create index if not exists idx_milestone_logs_milestone_id on milestone_logs(milestone_id);
create index if not exists idx_delay_requests_milestone_id on delay_requests(milestone_id);
create index if not exists idx_delay_requests_status on delay_requests(status);
create index if not exists idx_notifications_user_id on notifications(user_id);
create index if not exists idx_notifications_status on notifications(status);
create index if not exists idx_notifications_created_at on notifications(created_at);
create index if not exists idx_order_attachments_order_id on order_attachments(order_id);

-- =========================
-- ROW LEVEL SECURITY (RLS)
-- =========================

alter table profiles enable row level security;
alter table orders enable row level security;
alter table milestones enable row level security;
alter table milestone_logs enable row level security;
alter table delay_requests enable row level security;
alter table notifications enable row level security;
alter table order_attachments enable row level security;

-- Profiles: Users can read all, update own
create policy "profiles_select" on profiles
  for select using (auth.uid() is not null);

create policy "profiles_update" on profiles
  for update using (auth.uid() = user_id);

-- Orders: Only creator can read/write their orders (V1)
drop policy if exists "orders_select_own" on public.orders;
create policy "orders_select_own"
on public.orders for select
using (auth.uid() = created_by);

drop policy if exists "orders_insert_own" on public.orders;
create policy "orders_insert_own"
on public.orders for insert
with check (auth.uid() = created_by);

drop policy if exists "orders_update_own" on public.orders;
create policy "orders_update_own"
on public.orders for update
using (auth.uid() = created_by)
with check (auth.uid() = created_by);

drop policy if exists "orders_delete_own" on public.orders;
create policy "orders_delete_own"
on public.orders for delete
using (auth.uid() = created_by);

-- Milestones: Authenticated users can read all
create policy "milestones_select" on milestones
  for select using (auth.uid() is not null);

create policy "milestones_update" on milestones
  for update using (
    auth.uid() = owner_user_id or
    exists (
      select 1 from profiles
      where user_id = auth.uid()
      and (role = owner_role or role = 'admin')
    )
  );

-- Milestone logs: Authenticated users can read all
create policy "milestone_logs_select" on milestone_logs
  for select using (auth.uid() is not null);

create policy "milestone_logs_insert" on milestone_logs
  for insert with check (auth.uid() is not null);

-- Delay requests: Users can read related requests, create own
create policy "delay_requests_select" on delay_requests
  for select using (
    auth.uid() = requested_by or
    exists (
      select 1 from milestones m
      join profiles p on p.user_id = auth.uid()
      where m.id = delay_requests.milestone_id
      and (m.owner_user_id = auth.uid() or p.role = 'admin')
    )
  );

create policy "delay_requests_insert" on delay_requests
  for insert with check (auth.uid() = requested_by);

create policy "delay_requests_update" on delay_requests
  for update using (
    exists (
      select 1 from milestones m
      join profiles p on p.user_id = auth.uid()
      where m.id = delay_requests.milestone_id
      and (m.owner_user_id = auth.uid() or p.role = 'admin')
    )
  );

-- Notifications: Users can read own
create policy "notifications_select" on notifications
  for select using (auth.uid() = user_id);

create policy "notifications_update" on notifications
  for update using (auth.uid() = user_id);

create policy "notifications_insert" on notifications
  for insert with check (auth.uid() = user_id);

-- Order attachments: Authenticated users can read all, upload own
create policy "order_attachments_select" on order_attachments
  for select using (auth.uid() is not null);

create policy "order_attachments_insert" on order_attachments
  for insert with check (auth.uid() = uploaded_by);

-- =========================
-- FUNCTIONS
-- =========================

-- Updated_at trigger function
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Triggers for updated_at
drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

drop trigger if exists trg_profiles_updated_at on profiles;
create trigger trg_profiles_updated_at
before update on profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_milestones_updated_at on milestones;
create trigger trg_milestones_updated_at
before update on milestones
for each row execute function public.set_updated_at();

drop trigger if exists trg_delay_requests_updated_at on delay_requests;
create trigger trg_delay_requests_updated_at
before update on delay_requests
for each row execute function public.set_updated_at();

-- Function to create profile on user signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (user_id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    new.email,
    'sales'::user_role
  );
  return new;
end;
$$ language plpgsql security definer;

-- Trigger for new user signup
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
