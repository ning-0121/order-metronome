-- Migration for T5, T4, T6 features
-- Run this after the milestones table migration

-- =========================
-- T5: Milestone Logs Table
-- =========================

create table if not exists public.milestone_logs (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  milestone_id uuid not null references public.milestones(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  actor_user_id uuid not null, -- auth.users.id
  action text not null check (action in (
    'mark_done',
    'mark_in_progress',
    'mark_blocked',
    'unblock',
    'auto_advance',
    'request_delay',
    'approve_delay',
    'reject_delay',
    'recalc_schedule',
    'upload_evidence'
  )),
  note text,
  payload jsonb
);

create index if not exists idx_milestone_logs_milestone_id on public.milestone_logs(milestone_id);
create index if not exists idx_milestone_logs_order_id on public.milestone_logs(order_id);
create index if not exists idx_milestone_logs_created_at on public.milestone_logs(created_at);

alter table public.milestone_logs enable row level security;

drop policy if exists "milestone_logs_select_own" on public.milestone_logs;
create policy "milestone_logs_select_own"
on public.milestone_logs for select
using (public.is_order_owner(order_id));

drop policy if exists "milestone_logs_insert_own" on public.milestone_logs;
create policy "milestone_logs_insert_own"
on public.milestone_logs for insert
with check (public.is_order_owner(order_id));

-- =========================
-- T4: Notifications Table
-- =========================

create table if not exists public.notifications (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  milestone_id uuid references public.milestones(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('remind_48','remind_24','remind_12','overdue','blocked')),
  sent_to text not null, -- email
  sent_at timestamptz not null default now(),
  payload jsonb
);

create unique index if not exists idx_notifications_unique on public.notifications(milestone_id, kind, sent_to) where milestone_id is not null;
create index if not exists idx_notifications_order_id on public.notifications(order_id);
create index if not exists idx_notifications_sent_at on public.notifications(sent_at);

alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
on public.notifications for select
using (public.is_order_owner(order_id));

drop policy if exists "notifications_insert_own" on public.notifications;
create policy "notifications_insert_own"
on public.notifications for insert
with check (public.is_order_owner(order_id));

-- =========================
-- T6: Delay Requests Table
-- =========================

create table if not exists public.delay_requests (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  order_id uuid not null references public.orders(id) on delete cascade,
  milestone_id uuid not null references public.milestones(id) on delete cascade,
  requested_by uuid not null, -- auth.uid()
  reason_type text not null check (reason_type in (
    'customer_confirmation',
    'supplier_delay',
    'internal_delay',
    'logistics',
    'force_majeure',
    'other'
  )),
  reason_detail text not null,
  proposed_new_anchor_date date,
  proposed_new_due_at timestamptz,
  requires_customer_approval boolean not null default false,
  customer_approval_evidence_url text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_by uuid,
  approved_at timestamptz,
  decision_note text
);

create index if not exists idx_delay_requests_order_id on public.delay_requests(order_id);
create index if not exists idx_delay_requests_milestone_id on public.delay_requests(milestone_id);
create index if not exists idx_delay_requests_status on public.delay_requests(status);

-- Updated_at trigger
drop trigger if exists trg_delay_requests_updated_at on public.delay_requests;
create trigger trg_delay_requests_updated_at
before update on public.delay_requests
for each row execute function public.set_updated_at();

alter table public.delay_requests enable row level security;

drop policy if exists "delay_requests_select_own" on public.delay_requests;
create policy "delay_requests_select_own"
on public.delay_requests for select
using (public.is_order_owner(order_id));

drop policy if exists "delay_requests_insert_own" on public.delay_requests;
create policy "delay_requests_insert_own"
on public.delay_requests for insert
with check (public.is_order_owner(order_id));

drop policy if exists "delay_requests_update_own" on public.delay_requests;
create policy "delay_requests_update_own"
on public.delay_requests for update
using (public.is_order_owner(order_id))
with check (public.is_order_owner(order_id));
