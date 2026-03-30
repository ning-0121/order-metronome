-- Milestones table migration for Order Metronome (V1)
-- Run this in Supabase SQL Editor after the orders table migration

-- =========================
-- HELPER FUNCTION
-- =========================

-- Function to check if current user is the owner of an order
create or replace function public.is_order_owner(_order_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1
    from public.orders
    where id = _order_id
    and created_by = auth.uid()
  );
$$;

-- =========================
-- MILESTONES TABLE
-- =========================

-- Drop existing milestones table if it exists (for migration purposes)
-- Comment out the drop statement if you want to preserve existing data
-- drop table if exists public.milestones cascade;

create table if not exists public.milestones (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  order_id uuid not null references public.orders(id) on delete cascade,

  step_key text not null,
  name text not null,

  owner_role text not null check (owner_role in ('sales','finance','procurement','production','qc','logistics','admin')),
  owner_user_id uuid,

  planned_at timestamptz,
  due_at timestamptz,

  status text not null default 'not_started' check (status in ('not_started','in_progress','blocked','done')),

  is_critical boolean not null default false,
  evidence_required boolean not null default false,

  blocked_reason text,
  notes text
);

-- =========================
-- INDEXES
-- =========================

create index if not exists idx_milestones_order_id on public.milestones(order_id);
create index if not exists idx_milestones_due_at on public.milestones(due_at);

-- =========================
-- TRIGGERS
-- =========================

-- Updated_at trigger using existing function
drop trigger if exists trg_milestones_updated_at on public.milestones;
create trigger trg_milestones_updated_at
before update on public.milestones
for each row execute function public.set_updated_at();

-- =========================
-- ROW LEVEL SECURITY (RLS)
-- =========================

alter table public.milestones enable row level security;

-- Drop existing policies if they exist
drop policy if exists "milestones_select_own" on public.milestones;
drop policy if exists "milestones_insert_own" on public.milestones;
drop policy if exists "milestones_update_own" on public.milestones;
drop policy if exists "milestones_delete_own" on public.milestones;

-- RLS Policy: Only order creator can select milestones
create policy "milestones_select_own"
on public.milestones for select
using (public.is_order_owner(order_id));

-- RLS Policy: Only order creator can insert milestones
create policy "milestones_insert_own"
on public.milestones for insert
with check (public.is_order_owner(order_id));

-- RLS Policy: Only order creator can update milestones
create policy "milestones_update_own"
on public.milestones for update
using (public.is_order_owner(order_id))
with check (public.is_order_owner(order_id));

-- RLS Policy: Only order creator can delete milestones
create policy "milestones_delete_own"
on public.milestones for delete
using (public.is_order_owner(order_id));
