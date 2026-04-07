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


-- ===== 2026-03-16 P0修复：补建缺失表 + 修复字段不一致 =====

-- 补建 order_logs 表（订单主表变更审计）
CREATE TABLE IF NOT EXISTS public.order_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  actor_id uuid REFERENCES auth.users(id),
  action text NOT NULL,
  field_name text,
  old_value text,
  new_value text,
  note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_logs_order_id ON public.order_logs(order_id);
ALTER TABLE public.order_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_logs_select" ON public.order_logs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "order_logs_insert" ON public.order_logs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- 补建 cancel_requests 表（取消申请审批）
CREATE TABLE IF NOT EXISTS public.cancel_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  requested_by uuid REFERENCES auth.users(id) NOT NULL,
  reason_type text NOT NULL,
  reason_detail text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid REFERENCES auth.users(id),
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cancel_requests_order_id ON public.cancel_requests(order_id);
ALTER TABLE public.cancel_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cancel_requests_select" ON public.cancel_requests FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "cancel_requests_insert" ON public.cancel_requests FOR INSERT WITH CHECK (auth.uid() = requested_by);
CREATE POLICY "cancel_requests_update" ON public.cancel_requests FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
);

-- 补建 order_retrospectives 表（订单复盘）
CREATE TABLE IF NOT EXISTS public.order_retrospectives (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL UNIQUE,
  submitted_by uuid REFERENCES auth.users(id),
  on_time_delivery boolean,
  major_delay_reason text,
  key_issue text NOT NULL,
  root_cause text NOT NULL,
  what_worked text NOT NULL,
  improvement_actions jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.order_retrospectives ENABLE ROW LEVEL SECURITY;
CREATE POLICY "retrospectives_select" ON public.order_retrospectives FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "retrospectives_insert" ON public.order_retrospectives FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "retrospectives_update" ON public.order_retrospectives FOR UPDATE USING (auth.uid() IS NOT NULL);

-- 修复 profiles：补充 full_name 字段
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name text;
UPDATE public.profiles SET full_name = name WHERE full_name IS NULL;

-- 修复 orders RLS：管理员可读所有订单
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
CREATE POLICY "orders_select_all" ON public.orders
  FOR SELECT USING (
    auth.uid() = created_by
    OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

-- 保护 order_no 不可修改
CREATE OR REPLACE FUNCTION public.protect_order_no()
RETURNS trigger AS $$
BEGIN
  IF NEW.order_no IS DISTINCT FROM OLD.order_no THEN
    RAISE EXCEPTION 'order_no cannot be modified after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_order_no ON public.orders;
CREATE TRIGGER trg_protect_order_no
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.protect_order_no();

-- 补充 orders 表外贸核心字段
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS style_no text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS po_number text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS quantity integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancel_date date;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS colors jsonb DEFAULT '[]';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS sizes jsonb DEFAULT '[]';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS unit_price numeric(10,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS currency text DEFAULT 'USD';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_amount numeric(12,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_terms text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipment_qty integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS lifecycle_status text DEFAULT 'draft';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS retrospective_required boolean DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS retrospective_completed_at timestamptz;


-- ===== 2026-03-16 P0验收修复：字段对齐 =====

-- order_logs 补充 actor_user_id（代码写入字段）及生命周期字段
ALTER TABLE public.order_logs ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.order_logs ADD COLUMN IF NOT EXISTS from_status text;
ALTER TABLE public.order_logs ADD COLUMN IF NOT EXISTS to_status text;
ALTER TABLE public.order_logs ADD COLUMN IF NOT EXISTS payload text;

-- orders 表补充订单终结字段（decideCancel/completeOrder 写入）
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS termination_type text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS termination_reason text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS termination_approved_by uuid REFERENCES auth.users(id);

-- order_retrospectives 补充代码写入字段
ALTER TABLE public.order_retrospectives ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.order_retrospectives ADD COLUMN IF NOT EXISTS blocked_count integer DEFAULT 0;
ALTER TABLE public.order_retrospectives ADD COLUMN IF NOT EXISTS delay_request_count integer DEFAULT 0;


-- ===== 2026-03-16 V2.0 新增表（出货闭环+三方签核+外发物料+异常中心）=====

-- qc_inspections
CREATE TABLE IF NOT EXISTS public.qc_inspections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  milestone_id uuid REFERENCES public.milestones(id) ON DELETE SET NULL,
  inspection_type text NOT NULL CHECK (inspection_type IN ('mid','final','inline','re-inspection')),
  inspector_id uuid REFERENCES auth.users(id),
  inspection_date date NOT NULL DEFAULT CURRENT_DATE,
  qty_inspected integer NOT NULL DEFAULT 0,
  qty_pass integer NOT NULL DEFAULT 0,
  qty_fail integer NOT NULL DEFAULT 0,
  defect_details jsonb DEFAULT '[]',
  aql_level text DEFAULT 'II',
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','pass','fail','conditional')),
  notes text,
  evidence_urls jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- packing_lists
CREATE TABLE IF NOT EXISTS public.packing_lists (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  pl_number text UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','locked')),
  total_cartons integer DEFAULT 0,
  total_qty integer DEFAULT 0,
  total_net_weight numeric(10,2),
  total_gross_weight numeric(10,2),
  total_volume numeric(10,3),
  notes text,
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- packing_list_lines
CREATE TABLE IF NOT EXISTS public.packing_list_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  packing_list_id uuid REFERENCES public.packing_lists(id) ON DELETE CASCADE NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  style_no text, color text,
  size_breakdown jsonb DEFAULT '{}',
  qty_per_carton integer,
  carton_count integer NOT NULL DEFAULT 0,
  total_qty integer NOT NULL DEFAULT 0,
  net_weight_per_carton numeric(8,2),
  gross_weight_per_carton numeric(8,2),
  carton_dims_cm jsonb,
  sequence_no integer DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

-- shipment_confirmations（三方签核）
CREATE TABLE IF NOT EXISTS public.shipment_confirmations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  packing_list_id uuid REFERENCES public.packing_lists(id),
  shipment_qty integer NOT NULL,
  order_qty integer NOT NULL,
  qty_variance integer GENERATED ALWAYS AS (shipment_qty - order_qty) STORED,
  variance_reason text,
  variance_approved_by uuid REFERENCES auth.users(id),
  qc_pass_qty integer,
  qc_inspection_id uuid REFERENCES public.qc_inspections(id),
  sales_sign_id uuid REFERENCES auth.users(id),
  sales_signed_at timestamptz, sales_note text,
  warehouse_sign_id uuid REFERENCES auth.users(id),
  warehouse_signed_at timestamptz, warehouse_note text,
  finance_sign_id uuid REFERENCES auth.users(id),
  finance_signed_at timestamptz, finance_note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sales_signed','warehouse_signed','fully_signed','locked')),
  locked_at timestamptz, bl_number text, vessel_name text,
  etd_actual date, eta_actual date, notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- materials_bom
CREATE TABLE IF NOT EXISTS public.materials_bom (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  material_code text NOT NULL, material_name text NOT NULL,
  material_type text NOT NULL CHECK (material_type IN ('fabric','trim','lining','label','packing','other')),
  unit text NOT NULL DEFAULT 'meter',
  qty_per_piece numeric(10,4) NOT NULL,
  total_qty numeric(12,4), unit_cost numeric(10,4),
  supplier text, notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- outsource_jobs
CREATE TABLE IF NOT EXISTS public.outsource_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  job_type text NOT NULL CHECK (job_type IN ('sewing','embroidery','printing','washing','other')),
  factory_name text NOT NULL, factory_contact text,
  qty_sent integer NOT NULL DEFAULT 0,
  qty_returned integer DEFAULT 0, qty_pass integer DEFAULT 0,
  qty_defect integer DEFAULT 0, qty_scrap integer DEFAULT 0,
  qty_wip integer GENERATED ALWAYS AS (qty_sent - COALESCE(qty_pass,0) - COALESCE(qty_defect,0) - COALESCE(qty_returned,0) - COALESCE(qty_scrap,0)) STORED,
  sent_date date, expected_return_date date, actual_return_date date,
  unit_price numeric(10,4),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','returned','closed','exception')),
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- issue_slips + lines
CREATE TABLE IF NOT EXISTS public.issue_slips (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  outsource_job_id uuid REFERENCES public.outsource_jobs(id) ON DELETE SET NULL,
  slip_type text NOT NULL DEFAULT 'issue' CHECK (slip_type IN ('issue','return','scrap','adjust')),
  slip_number text UNIQUE, issued_to text,
  issued_by uuid REFERENCES auth.users(id),
  received_by uuid REFERENCES auth.users(id),
  slip_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','void')),
  notes text, confirmed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.issue_slip_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_slip_id uuid REFERENCES public.issue_slips(id) ON DELETE CASCADE NOT NULL,
  bom_id uuid REFERENCES public.materials_bom(id) ON DELETE SET NULL,
  material_code text NOT NULL, material_name text NOT NULL, unit text NOT NULL,
  qty_requested numeric(12,4), qty_issued numeric(12,4) NOT NULL DEFAULT 0,
  qty_returned numeric(12,4) DEFAULT 0, unit_cost numeric(10,4), notes text,
  created_at timestamptz DEFAULT now()
);

-- production_reports
CREATE TABLE IF NOT EXISTS public.production_reports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  report_date date NOT NULL DEFAULT CURRENT_DATE,
  reported_by uuid REFERENCES auth.users(id),
  qty_produced integer NOT NULL DEFAULT 0,
  qty_cumulative integer DEFAULT 0,
  qty_defect integer DEFAULT 0,
  defect_rate numeric(5,2) GENERATED ALWAYS AS (
    CASE WHEN qty_produced > 0 THEN ROUND((qty_defect::numeric / qty_produced) * 100, 2) ELSE 0 END
  ) STORED,
  workers_count integer, efficiency_rate numeric(5,2),
  issues text, notes text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(order_id, report_date)
);

-- exceptions（异常中心）
CREATE TABLE IF NOT EXISTS public.exceptions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  milestone_id uuid REFERENCES public.milestones(id) ON DELETE SET NULL,
  exception_type text NOT NULL CHECK (exception_type IN ('quality','material_delay','production_delay','shipment','customer_change','qty_variance','cost_overrun','supplier','other')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  title text NOT NULL, description text, root_cause text,
  owner_id uuid REFERENCES auth.users(id),
  reported_by uuid REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed','escalated')),
  escalated_to uuid REFERENCES auth.users(id), escalated_at timestamptz,
  resolution text,
  resolved_by uuid REFERENCES auth.users(id), resolved_at timestamptz,
  closed_by uuid REFERENCES auth.users(id), closed_at timestamptz,
  due_date date, auto_generated boolean DEFAULT false, source_ref jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- cost_reconciliations
CREATE TABLE IF NOT EXISTS public.cost_reconciliations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL UNIQUE,
  created_by uuid REFERENCES auth.users(id),
  budgeted_material_cost numeric(12,2) DEFAULT 0,
  budgeted_labor_cost numeric(12,2) DEFAULT 0,
  budgeted_outsource_cost numeric(12,2) DEFAULT 0,
  budgeted_shipping_cost numeric(12,2) DEFAULT 0,
  budgeted_other_cost numeric(12,2) DEFAULT 0,
  actual_material_cost numeric(12,2) DEFAULT 0,
  actual_labor_cost numeric(12,2) DEFAULT 0,
  actual_outsource_cost numeric(12,2) DEFAULT 0,
  actual_shipping_cost numeric(12,2) DEFAULT 0,
  actual_other_cost numeric(12,2) DEFAULT 0,
  invoice_amount numeric(12,2), currency text DEFAULT 'USD',
  exchange_rate numeric(8,4) DEFAULT 1,
  variance_notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','locked')),
  submitted_by uuid REFERENCES auth.users(id), submitted_at timestamptz,
  approved_by uuid REFERENCES auth.users(id), approved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ===== 2026-03-23: P0 安全加固（RLS + 角色授权 + notifications 对齐） =====

-- 1) profiles: 强化 RLS 与角色修改保护
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 管理员判定函数（SECURITY DEFINER，避免 profiles RLS 递归）
CREATE OR REPLACE FUNCTION public.is_admin_user(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.user_id = uid
      AND p.role = 'admin'
  );
$$;

-- 非管理员不得修改 role（含自我提权）
CREATE OR REPLACE FUNCTION public.guard_profiles_role_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT public.is_admin_user(auth.uid()) THEN
      RAISE EXCEPTION 'only admin can update role';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profiles_role_update ON public.profiles;
CREATE TRIGGER trg_guard_profiles_role_update
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.guard_profiles_role_update();

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_authenticated" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own_basic" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_admin_all" ON public.profiles;

-- authenticated 用户可读
CREATE POLICY "profiles_select_authenticated"
ON public.profiles
FOR SELECT
USING (auth.uid() IS NOT NULL);

-- 用户只能插入自己的 profile
CREATE POLICY "profiles_insert_own"
ON public.profiles
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- 用户只能更新自己的基本信息（role 变更由 trigger + admin 限制）
CREATE POLICY "profiles_update_own_basic"
ON public.profiles
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- 只有 admin 可更新任意用户（含 role）
CREATE POLICY "profiles_update_admin_all"
ON public.profiles
FOR UPDATE
USING (public.is_admin_user(auth.uid()))
WITH CHECK (public.is_admin_user(auth.uid()));

-- 2) orders/milestones: 确保启用 RLS，并校验已有 policy 存在
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  orders_policy_count int;
  milestones_policy_count int;
BEGIN
  SELECT COUNT(*) INTO orders_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'orders';

  SELECT COUNT(*) INTO milestones_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'milestones';

  IF orders_policy_count = 0 THEN
    RAISE EXCEPTION 'orders has RLS enabled but no policy';
  END IF;
  IF milestones_policy_count = 0 THEN
    RAISE EXCEPTION 'milestones has RLS enabled but no policy';
  END IF;
END $$;

-- 4) notifications: 双 schema 兼容（最小修复，避免线上读写不一致）
DO $$
BEGIN
  CREATE TYPE notification_status AS ENUM ('unread', 'read');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS related_order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS related_milestone_id uuid REFERENCES public.milestones(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status notification_status DEFAULT 'unread',
  ADD COLUMN IF NOT EXISTS email_sent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS milestone_id uuid REFERENCES public.milestones(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS sent_to text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS payload jsonb;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id_v2 ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_related_order_id_v2 ON public.notifications(related_order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_order_id_v2 ON public.notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_kind_v2 ON public.notifications(kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique_milestone_kind_sent_to_v2
  ON public.notifications(milestone_id, kind, sent_to)
  WHERE milestone_id IS NOT NULL AND kind IS NOT NULL AND sent_to IS NOT NULL;

-- 3) orders: 修复 update/delete RLS — admin 可操作所有订单
DROP POLICY IF EXISTS "orders_update_own" ON public.orders;
CREATE POLICY "orders_update_own_or_admin"
ON public.orders FOR UPDATE
USING (
  auth.uid() = created_by
  OR public.is_admin_user(auth.uid())
)
WITH CHECK (
  auth.uid() = created_by
  OR public.is_admin_user(auth.uid())
);

DROP POLICY IF EXISTS "orders_delete_own" ON public.orders;
CREATE POLICY "orders_delete_own_or_admin"
ON public.orders FOR DELETE
USING (
  auth.uid() = created_by
  OR public.is_admin_user(auth.uid())
);

-- ===== 2026-03-23: 客户主数据系统 =====

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_name text NOT NULL,
  company_name text,
  contact_name text,
  email text,
  phone text,
  country text,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_name
  ON public.customers(customer_name);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_select_authenticated" ON public.customers
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "customers_insert_authenticated" ON public.customers
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "customers_update_admin" ON public.customers
  FOR UPDATE USING (public.is_admin_user(auth.uid()));

-- orders 表新增 customer_id
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id);

-- 迁移历史数据：为已有 customer_name 创建 customer 记录并回填
INSERT INTO public.customers (customer_name)
SELECT DISTINCT customer_name FROM public.orders
WHERE customer_name IS NOT NULL
ON CONFLICT (customer_name) DO NOTHING;

UPDATE public.orders o
SET customer_id = c.id
FROM public.customers c
WHERE o.customer_name = c.customer_name
  AND o.customer_id IS NULL;

-- ===== 2026-03-23: 理单负责制 + 报价审批 =====

-- 订单负责人（理单）
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id);

-- 回填：现有订单的 owner = created_by
UPDATE public.orders SET owner_user_id = created_by WHERE owner_user_id IS NULL;

-- 报价审批字段
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS quote_status text DEFAULT 'pending'
    CHECK (quote_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS quote_approved_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS quote_approved_at timestamptz;

-- ===== 2026-03-23: RLS for operation tables =====

-- materials_bom
ALTER TABLE public.materials_bom ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bom_select_auth" ON public.materials_bom FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "bom_insert_auth" ON public.materials_bom FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "bom_update_auth" ON public.materials_bom FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "bom_delete_auth" ON public.materials_bom FOR DELETE USING (auth.uid() IS NOT NULL);

-- outsource_jobs
ALTER TABLE public.outsource_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "outsource_select_auth" ON public.outsource_jobs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "outsource_insert_auth" ON public.outsource_jobs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "outsource_update_auth" ON public.outsource_jobs FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "outsource_delete_auth" ON public.outsource_jobs FOR DELETE USING (auth.uid() IS NOT NULL);

-- qc_inspections
ALTER TABLE public.qc_inspections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "qc_select_auth" ON public.qc_inspections FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "qc_insert_auth" ON public.qc_inspections FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "qc_update_auth" ON public.qc_inspections FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "qc_delete_auth" ON public.qc_inspections FOR DELETE USING (auth.uid() IS NOT NULL);

-- packing_lists
ALTER TABLE public.packing_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "packing_select_auth" ON public.packing_lists FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "packing_insert_auth" ON public.packing_lists FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "packing_update_auth" ON public.packing_lists FOR UPDATE USING (auth.uid() IS NOT NULL);

-- packing_list_lines
ALTER TABLE public.packing_list_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "packing_lines_select_auth" ON public.packing_list_lines FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "packing_lines_insert_auth" ON public.packing_list_lines FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "packing_lines_update_auth" ON public.packing_list_lines FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "packing_lines_delete_auth" ON public.packing_list_lines FOR DELETE USING (auth.uid() IS NOT NULL);

-- shipment_confirmations
ALTER TABLE public.shipment_confirmations ENABLE ROW LEVEL SECURITY;

-- ── 2026-03-23: 订单基础业务字段补充 ──
-- order_date 已存在（由之前 migration 添加），仅补 factory_name
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS factory_name text;

-- ── 2026-03-23: 个人备忘录 ──
CREATE TABLE IF NOT EXISTS public.user_memos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  remind_at timestamptz,
  is_done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_memos_user_id ON public.user_memos(user_id);

ALTER TABLE public.user_memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "memo_select_own" ON public.user_memos FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "memo_insert_own" ON public.user_memos FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "memo_update_own" ON public.user_memos FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "memo_delete_own" ON public.user_memos FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "shipment_select_auth" ON public.shipment_confirmations FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "shipment_insert_auth" ON public.shipment_confirmations FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "shipment_update_auth" ON public.shipment_confirmations FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ===== 2026-03-24: 修复创建订单失败 — order_type CHECK 约束 + 缺失列 =====
-- 问题：order_type CHECK 只允许 sample/bulk，但表单有 repeat 选项
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('sample', 'bulk', 'repeat'));

-- 确保 order_date 列存在
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_date date;

-- 确保 customer_id 列存在
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_id uuid;

-- ===== 2026-03-24: 双日期机制 — 新增 actual_at + 工厂完成节点 =====
-- actual_at: 用户手动填入的实际/预计完成日期，用于交期预警
ALTER TABLE public.milestones ADD COLUMN IF NOT EXISTS actual_at timestamptz DEFAULT NULL;

-- ===== 2026-03-24: 修复 order_attachments 字段不匹配 =====
-- 上传代码写入 file_type / storage_path，但原表缺少这两列
ALTER TABLE public.order_attachments ADD COLUMN IF NOT EXISTS file_type text;
ALTER TABLE public.order_attachments ADD COLUMN IF NOT EXISTS storage_path text;
-- 放宽 uploaded_by NOT NULL（客户端上传时可能拿不到 user）
ALTER TABLE public.order_attachments ALTER COLUMN uploaded_by DROP NOT NULL;

-- ===== 2026-03-24: 客户主数据 + 工厂主数据 =====

-- 1. 客户表字段补齐（表已存在，补新列）
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS customer_code text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS customer_type text DEFAULT 'regular'
  CHECK (customer_type IN ('regular', 'vip', 'trial', 'inactive'));
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_code
  ON public.customers(customer_code) WHERE customer_code IS NOT NULL AND deleted_at IS NULL;

-- 2. 工厂主数据表
CREATE TABLE IF NOT EXISTS public.factories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  factory_code text,
  factory_name text NOT NULL,
  contact_name text,
  phone text,
  country text,
  city text,
  address text,
  category text DEFAULT 'garment'
    CHECK (category IN ('garment', 'fabric', 'trim', 'printing', 'washing', 'embroidery', 'other')),
  cooperation_status text DEFAULT 'active'
    CHECK (cooperation_status IN ('active', 'trial', 'suspended', 'blacklisted')),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz DEFAULT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_factories_name
  ON public.factories(factory_name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_factories_code
  ON public.factories(factory_code) WHERE factory_code IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE public.factories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "factories_select_auth" ON public.factories FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "factories_insert_auth" ON public.factories FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "factories_update_auth" ON public.factories FOR UPDATE USING (auth.uid() IS NOT NULL);

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_factories_updated_at ON public.factories;
CREATE TRIGGER trg_factories_updated_at
  BEFORE UPDATE ON public.factories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated_at ON public.customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. orders 表增加 factory_id
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS factory_id uuid REFERENCES public.factories(id);

-- 4. outsource_jobs 表增加 factory_id
ALTER TABLE public.outsource_jobs ADD COLUMN IF NOT EXISTS factory_id uuid REFERENCES public.factories(id);

-- 5. 历史数据迁移：已有 factory_name 自动创建 factory 记录并回填
INSERT INTO public.factories (factory_name)
SELECT DISTINCT factory_name FROM public.orders
WHERE factory_name IS NOT NULL AND factory_name != ''
ON CONFLICT (factory_name) DO NOTHING;

INSERT INTO public.factories (factory_name)
SELECT DISTINCT factory_name FROM public.outsource_jobs
WHERE factory_name IS NOT NULL AND factory_name != ''
  AND factory_name NOT IN (SELECT factory_name FROM public.factories WHERE deleted_at IS NULL)
ON CONFLICT (factory_name) DO NOTHING;

UPDATE public.orders o
SET factory_id = f.id
FROM public.factories f
WHERE o.factory_name = f.factory_name
  AND o.factory_id IS NULL
  AND f.deleted_at IS NULL;

UPDATE public.outsource_jobs oj
SET factory_id = f.id
FROM public.factories f
WHERE oj.factory_name = f.factory_name
  AND oj.factory_id IS NULL
  AND f.deleted_at IS NULL;

-- ===== 2026-03-24: 修复附件上传 RLS + Storage bucket =====

-- 放宽 order_attachments INSERT 策略：允许已登录用户插入
DROP POLICY IF EXISTS "order_attachments_insert" ON public.order_attachments;
CREATE POLICY "order_attachments_insert" ON public.order_attachments
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- 确保 Storage bucket 存在（需要在 Supabase Dashboard 手动创建 order-docs bucket）

-- ===== 2026-03-27: 调整角色体系 + 节点归属 =====

-- 1. 添加 merchandiser 到 user_role 枚举
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'merchandiser';

-- 2. 修复历史数据：之前 merchandiser 被映射为 sales 入库
--    现在跟单节点应该存为 merchandiser
UPDATE public.milestones SET owner_role = 'merchandiser'
WHERE step_key IN (
  'pre_production_sample_ready',  -- 产前样准备完成
  'factory_confirmed',            -- 确认工厂
  'production_kickoff',           -- 生产启动/开裁
  'pre_production_meeting',       -- 产前会
  'mid_qc_check',                 -- 中查
  'final_qc_check',               -- 尾查
  'factory_completion',           -- 工厂完成
  'inspection_release'            -- 验货/放行
) AND owner_role = 'sales';

-- 3. 订舱/报关：logistics → sales（业务负责）
UPDATE public.milestones SET owner_role = 'sales'
WHERE step_key = 'booking_done' AND owner_role = 'logistics';

UPDATE public.milestones SET owner_role = 'sales'
WHERE step_key = 'customs_export' AND owner_role = 'logistics';

-- ===== 2026-03-27 备忘录关联订单节拍 =====
ALTER TABLE public.user_memos ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id);
ALTER TABLE public.user_memos ADD COLUMN IF NOT EXISTS milestone_id uuid REFERENCES public.milestones(id);
ALTER TABLE public.user_memos ADD COLUMN IF NOT EXISTS linked_order_no text;

CREATE INDEX IF NOT EXISTS idx_user_memos_order_id ON public.user_memos(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_memos_milestone_id ON public.user_memos(milestone_id) WHERE milestone_id IS NOT NULL;

-- ===== 2026-03-27 提成评价机制 =====
CREATE TABLE IF NOT EXISTS public.order_commissions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,

  -- 五维评分明细
  score_ontime integer NOT NULL DEFAULT 0,
  score_no_block integer NOT NULL DEFAULT 0,
  score_no_delay integer NOT NULL DEFAULT 0,
  score_quality integer NOT NULL DEFAULT 0,
  score_delivery integer NOT NULL DEFAULT 0,

  total_score integer NOT NULL DEFAULT 0,
  grade text NOT NULL DEFAULT 'A',
  commission_rate numeric(4,2) NOT NULL DEFAULT 1.00,

  vetoed boolean NOT NULL DEFAULT false,
  veto_reason text,

  detail_json jsonb,

  calculated_at timestamptz NOT NULL DEFAULT now(),
  calculated_by uuid REFERENCES auth.users(id),

  UNIQUE(order_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_order_commissions_order ON public.order_commissions(order_id);
CREATE INDEX IF NOT EXISTS idx_order_commissions_user ON public.order_commissions(user_id);

-- RLS: 管理员全权，普通用户只读自己的
ALTER TABLE public.order_commissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "commission_select_own_or_admin" ON public.order_commissions
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

CREATE POLICY "commission_insert_admin" ON public.order_commissions
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

CREATE POLICY "commission_update_admin" ON public.order_commissions
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

-- ===== 2026-03-28 回填旧订单：业务/理单关卡自动分配给订单创建者 =====
UPDATE public.milestones m
SET owner_user_id = o.owner_user_id
FROM public.orders o
WHERE m.order_id = o.id
  AND m.owner_user_id IS NULL
  AND o.owner_user_id IS NOT NULL
  AND m.owner_role IN ('sales', 'merchandiser');

-- ===== 2026-03-28 修正关卡角色：原辅料到货验收归跟单 =====
UPDATE public.milestones SET owner_role = 'merchandiser'
WHERE step_key = 'materials_received_inspected' AND owner_role = 'sales';

-- 清除跟单关卡上错误分配的业务人员（跟单由管理员另行指定）
UPDATE public.milestones m
SET owner_user_id = NULL
FROM public.orders o
WHERE m.order_id = o.id
  AND m.owner_user_id = o.owner_user_id
  AND m.owner_role = 'merchandiser';

-- ===== 2026-03-28 订单特殊标记 + 备注 =====
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS special_tags text[] DEFAULT '{}';

-- ===== 2026-03-28 新增节拍：订单启动会（order_kickoff_meeting） =====
-- 先把原第3位及之后的节点序号+1，给启动会腾出位置
UPDATE public.milestones
SET sequence_number = sequence_number + 1
WHERE sequence_number >= 3
  AND order_id IN (
    SELECT DISTINCT order_id FROM public.milestones WHERE step_key = 'finance_approval'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.milestones m2
    WHERE m2.order_id = milestones.order_id
      AND m2.step_key = 'order_kickoff_meeting'
  );

-- 为所有现有订单补齐"订单启动会"节点（财务审核后2日内，序号3）
INSERT INTO public.milestones (
  id, order_id, step_key, name, owner_role, owner_user_id,
  planned_at, due_at, actual_at, status,
  is_critical, evidence_required, notes, sequence_number,
  created_at, updated_at
)
SELECT
  uuid_generate_v4(),
  m_fin.order_id,
  'order_kickoff_meeting',
  '订单启动会',
  'sales',
  NULL,
  m_fin.due_at + interval '2 days',
  m_fin.due_at + interval '2 days',
  NULL,
  'pending',
  true,
  false,
  NULL,
  3,
  now(),
  now()
FROM public.milestones m_fin
WHERE m_fin.step_key = 'finance_approval'
  AND NOT EXISTS (
    SELECT 1 FROM public.milestones m2
    WHERE m2.order_id = m_fin.order_id
      AND m2.step_key = 'order_kickoff_meeting'
  );

-- ===== 2026-03-28 AI 知识库数据管道 =====

-- 1. 公司画像表（SaaS 多租户预留）
CREATE TABLE IF NOT EXISTS public.company_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL DEFAULT 'Qimo Technology',
  industry text NOT NULL DEFAULT 'apparel',        -- apparel / textile / accessories / footwear / home_textile / other
  industry_sub text,                                -- 细分：casual_wear / sportswear / workwear / underwear / children 等
  company_scale text NOT NULL DEFAULT 'small',      -- micro(<10人) / small(10-50) / medium(50-200) / large(200+)
  annual_order_volume text,                         -- yearly order count range: <50 / 50-200 / 200-500 / 500+
  main_markets text[] DEFAULT '{"US","EU"}',        -- 主要出口市场
  main_products text[] DEFAULT '{}',                -- 主营品类
  employee_count int,
  erp_system text,                                  -- 已用ERP：none / custom / sap / other
  pain_points text[] DEFAULT '{}',                  -- 核心痛点标签
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read company_profile"
  ON public.company_profile FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can manage company_profile"
  ON public.company_profile FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 插入默认公司画像
INSERT INTO public.company_profile (company_name, industry, industry_sub, company_scale, annual_order_volume, main_markets, main_products)
VALUES ('绮陌服饰', 'apparel', 'casual_wear', 'small', '50-200', '{"US","EU"}', '{"针织","梭织"}')
ON CONFLICT DO NOTHING;

-- 2. AI 知识库统一表
CREATE TABLE IF NOT EXISTS public.ai_knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 知识分类
  knowledge_type text NOT NULL,                    -- employee / customer / factory / process / industry
  category text NOT NULL DEFAULT 'general',        -- 细分类别
  subcategory text,                                -- 三级分类

  -- 知识内容
  title text NOT NULL,                             -- 知识标题（一句话总结）
  content text NOT NULL,                           -- 详细内容
  structured_data jsonb DEFAULT '{}',              -- 结构化数据（指标、统计、KV对）

  -- 来源追溯
  source_type text NOT NULL,                       -- retrospective / customer_memory / milestone_log / delay_request / production_report / memo / manual
  source_id text,                                  -- 原始记录ID
  source_table text,                               -- 来源表名

  -- 关联维度
  customer_name text,                              -- 关联客户
  factory_name text,                               -- 关联工厂
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  employee_role text,                              -- 关联角色

  -- 行业/规模标签（SaaS推广用）
  industry_tag text DEFAULT 'apparel',             -- 适用行业
  scale_tag text DEFAULT 'small',                  -- 适用规模
  market_tags text[] DEFAULT '{}',                 -- 适用市场

  -- 质量与权重
  confidence text DEFAULT 'medium',                -- high / medium / low
  frequency int DEFAULT 1,                         -- 出现频次（同类知识聚合）
  impact_level text DEFAULT 'medium',              -- high / medium / low
  is_actionable boolean DEFAULT true,              -- 是否可操作（vs 纯信息）

  -- 状态
  status text DEFAULT 'active',                    -- active / archived / merged
  reviewed_by uuid,
  reviewed_at timestamptz,

  -- 元数据
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_kb_type ON public.ai_knowledge_base(knowledge_type);
CREATE INDEX IF NOT EXISTS idx_ai_kb_source ON public.ai_knowledge_base(source_type);
CREATE INDEX IF NOT EXISTS idx_ai_kb_customer ON public.ai_knowledge_base(customer_name);
CREATE INDEX IF NOT EXISTS idx_ai_kb_factory ON public.ai_knowledge_base(factory_name);
CREATE INDEX IF NOT EXISTS idx_ai_kb_industry ON public.ai_knowledge_base(industry_tag, scale_tag);
CREATE INDEX IF NOT EXISTS idx_ai_kb_created ON public.ai_knowledge_base(created_at DESC);

ALTER TABLE public.ai_knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read ai_knowledge_base"
  ON public.ai_knowledge_base FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert ai_knowledge_base"
  ON public.ai_knowledge_base FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update ai_knowledge_base"
  ON public.ai_knowledge_base FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- 3. 数据采集日志（记录每次管道运行）
CREATE TABLE IF NOT EXISTS public.ai_collection_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  triggered_by uuid REFERENCES auth.users(id),
  source_type text NOT NULL,
  records_scanned int DEFAULT 0,
  records_ingested int DEFAULT 0,
  records_skipped int DEFAULT 0,
  duration_ms int,
  error_message text,
  metadata jsonb DEFAULT '{}'
);

ALTER TABLE public.ai_collection_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read ai_collection_log"
  ON public.ai_collection_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert ai_collection_log"
  ON public.ai_collection_log FOR INSERT TO authenticated WITH CHECK (true);
-- ===== 2026-03-28 修正排期：产前样移至原辅料到货后，生产启动移至产前样确认后 =====
-- 变更：production_order_upload Day2→4, pre_production_sample_ready Day5→14,
--       pre_production_sample_sent Day6→15, pre_production_sample_approved Day10→19,
--       production_kickoff Day12→20
-- 原理：用 po_confirmed(Day0) 和 shipment_execute(Day44) 的 due_at 反推缩放比例
--       new_due_at = t0 + (new_day / 44) * (anchor - t0)

UPDATE public.milestones target
SET due_at = sub.new_due
FROM (
  SELECT
    m.id,
    t0.t0_at + (m_day.new_day::double precision / 44.0) * (anchor.anchor_at - t0.t0_at) AS new_due
  FROM public.milestones m
  INNER JOIN (
    SELECT order_id, due_at AS t0_at FROM public.milestones WHERE step_key = 'po_confirmed'
  ) t0 ON t0.order_id = m.order_id
  INNER JOIN (
    SELECT order_id, due_at AS anchor_at FROM public.milestones WHERE step_key = 'shipment_execute'
  ) anchor ON anchor.order_id = m.order_id
  INNER JOIN (
    VALUES
      ('production_order_upload', 4),
      ('pre_production_sample_ready', 14),
      ('pre_production_sample_sent', 15),
      ('pre_production_sample_approved', 19),
      ('production_kickoff', 20)
  ) AS m_day(step_key, new_day) ON m_day.step_key = m.step_key
  WHERE m.status IN ('pending', 'in_progress')
    AND t0.t0_at IS NOT NULL
    AND anchor.anchor_at IS NOT NULL
    AND anchor.anchor_at > t0.t0_at
) sub
WHERE target.id = sub.id;

-- ===== 2026-03-30 补充 RLS 策略（5张表） =====
ALTER TABLE IF EXISTS production_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS issue_slips ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS issue_slip_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cost_reconciliations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'production_reports_auth') THEN
    CREATE POLICY "production_reports_auth" ON production_reports FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'exceptions_auth') THEN
    CREATE POLICY "exceptions_auth" ON exceptions FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'issue_slips_auth') THEN
    CREATE POLICY "issue_slips_auth" ON issue_slips FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'issue_slip_lines_auth') THEN
    CREATE POLICY "issue_slip_lines_auth" ON issue_slip_lines FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cost_reconciliations_auth') THEN
    CREATE POLICY "cost_reconciliations_auth" ON cost_reconciliations FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- ===== 2026-03-30 订单表新增字段 =====
ALTER TABLE orders ADD COLUMN IF NOT EXISTS factory_date date DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS style_count integer DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS color_count integer DEFAULT NULL;

-- ===== 2026-03-31 导入模式批量更新 RPC（绕过 RLS） =====
CREATE OR REPLACE FUNCTION admin_update_milestone(
  _milestone_id uuid,
  _updates jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE milestones SET
    status = COALESCE(_updates->>'status', status),
    actual_at = CASE WHEN _updates ? 'actual_at' THEN (_updates->>'actual_at')::timestamptz ELSE actual_at END,
    due_at = CASE WHEN _updates ? 'due_at' THEN (_updates->>'due_at')::timestamptz ELSE due_at END,
    planned_at = CASE WHEN _updates ? 'planned_at' THEN (_updates->>'planned_at')::timestamptz ELSE planned_at END
  WHERE id = _milestone_id;
END;
$$;

-- ===== 2026-03-31 检查清单系统 =====
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS checklist_data JSONB DEFAULT NULL;

-- 更新 RPC 支持 checklist_data
CREATE OR REPLACE FUNCTION admin_update_milestone(
  _milestone_id uuid,
  _updates jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE milestones SET
    status = COALESCE(_updates->>'status', status),
    actual_at = CASE WHEN _updates ? 'actual_at' THEN (_updates->>'actual_at')::timestamptz ELSE actual_at END,
    due_at = CASE WHEN _updates ? 'due_at' THEN (_updates->>'due_at')::timestamptz ELSE due_at END,
    planned_at = CASE WHEN _updates ? 'planned_at' THEN (_updates->>'planned_at')::timestamptz ELSE planned_at END,
    checklist_data = CASE WHEN _updates ? 'checklist_data' THEN (_updates->'checklist_data') ELSE checklist_data END
  WHERE id = _milestone_id;
END;
$$;

-- ===== 2026-03-31 内部订单号（实体订单册编号） =====
ALTER TABLE orders ADD COLUMN IF NOT EXISTS internal_order_no text DEFAULT NULL;

-- ===== 2026-03-30 历史订单导入模式 =====
ALTER TABLE orders ADD COLUMN IF NOT EXISTS imported_at timestamptz DEFAULT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS import_current_step text DEFAULT NULL;

-- ===== 2026-04-06 客户邮箱域名映射 =====
CREATE TABLE IF NOT EXISTS public.customer_email_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  email_domain text NOT NULL,
  sample_email text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(customer_name, email_domain)
);
ALTER TABLE public.customer_email_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customer_email_domains_authenticated" ON public.customer_email_domains
  FOR ALL USING (auth.uid() IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_customer_email_domains_domain ON public.customer_email_domains(email_domain);

-- ===== 2026-04-06 邮件线索追踪 =====
ALTER TABLE public.mail_inbox
  ADD COLUMN IF NOT EXISTS message_id text,
  ADD COLUMN IF NOT EXISTS in_reply_to text,
  ADD COLUMN IF NOT EXISTS thread_id text,
  ADD COLUMN IF NOT EXISTS is_thread_start boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_mail_inbox_thread_id ON public.mail_inbox(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_inbox_message_id ON public.mail_inbox(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_inbox_from_email ON public.mail_inbox(from_email);

-- ===== 2026-04-06 执行对照 + 每日简报 =====
CREATE TABLE IF NOT EXISTS public.compliance_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_type text NOT NULL,
  mail_inbox_id uuid REFERENCES public.mail_inbox(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_name text,
  salesperson_user_id uuid REFERENCES auth.users(id),
  title text NOT NULL,
  description text,
  severity text DEFAULT 'medium',
  email_date timestamptz,
  days_since_email integer,
  status text DEFAULT 'open',
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  resolution_note text,
  agent_action_id uuid REFERENCES public.agent_actions(id) ON DELETE SET NULL,
  dedup_key text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_findings_status ON public.compliance_findings(status);
CREATE INDEX IF NOT EXISTS idx_compliance_findings_salesperson ON public.compliance_findings(salesperson_user_id);
ALTER TABLE public.compliance_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "compliance_findings_authenticated" ON public.compliance_findings FOR ALL USING (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.daily_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  briefing_date date NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  summary_text text,
  total_emails integer DEFAULT 0,
  urgent_count integer DEFAULT 0,
  compliance_count integer DEFAULT 0,
  wechat_sent boolean DEFAULT false,
  email_sent boolean DEFAULT false,
  notification_sent boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, briefing_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_briefings_user_date ON public.daily_briefings(user_id, briefing_date DESC);
ALTER TABLE public.daily_briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_briefings_own_select" ON public.daily_briefings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "daily_briefings_insert" ON public.daily_briefings FOR INSERT WITH CHECK (true);

-- ===== 2026-04-07 企业微信用户ID =====
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS wecom_userid text;

-- ===== 2026-04-07 延期申请原因分类 =====
ALTER TABLE public.delay_requests
  ADD COLUMN IF NOT EXISTS reason_category text CHECK (
    reason_category IN ('customer', 'supplier', 'internal', 'force_majeure')
  );
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS delay_days integer;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS impacts_final_delivery boolean DEFAULT false;

-- ===== 2026-04-07 订单灵活性增强 =====
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS skip_pre_production_sample boolean DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS sample_confirm_days_override integer;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS factory_ids text[];
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS factory_names text[];
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS default_sample_confirm_days integer;

-- ===== 2026-04-08 邮件 AI 加强 — 差异持久化 + 无声失败监控 =====
ALTER TABLE public.mail_inbox
  ADD COLUMN IF NOT EXISTS processing_status text DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'fully_matched', 'matched_customer', 'unmatched', 'parse_failed', 'skipped'));
ALTER TABLE public.mail_inbox ADD COLUMN IF NOT EXISTS last_processed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_mail_inbox_processing_status ON public.mail_inbox(processing_status, received_at DESC)
  WHERE processing_status IN ('unmatched', 'matched_customer', 'parse_failed');

CREATE TABLE IF NOT EXISTS public.email_order_diffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_inbox_id uuid REFERENCES public.mail_inbox(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  field text NOT NULL,
  email_value text,
  order_value text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('high', 'medium', 'low')),
  suggestion text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored', 'false_positive')),
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  resolution_note text,
  detected_at timestamptz DEFAULT now()
);
-- 去重：(mail_inbox_id, order_id, field) 三元组唯一
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_order_diff_dedup
  ON public.email_order_diffs(mail_inbox_id, order_id, field);
CREATE INDEX IF NOT EXISTS idx_email_order_diffs_order ON public.email_order_diffs(order_id, status);
CREATE INDEX IF NOT EXISTS idx_email_order_diffs_status ON public.email_order_diffs(status, severity, detected_at DESC);
ALTER TABLE public.email_order_diffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_order_diffs_authenticated" ON public.email_order_diffs;
CREATE POLICY "email_order_diffs_authenticated" ON public.email_order_diffs FOR ALL USING (auth.uid() IS NOT NULL);

-- ===== 2026-04-08 订单创建前价格审批 =====
CREATE TABLE IF NOT EXISTS public.pre_order_price_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  customer_name text,
  po_number text,
  form_snapshot jsonb NOT NULL DEFAULT '{}',
  price_diffs jsonb NOT NULL DEFAULT '[]',
  summary text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_pre_order_price_approvals_status ON public.pre_order_price_approvals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pre_order_price_approvals_requester ON public.pre_order_price_approvals(requested_by, status);
ALTER TABLE public.pre_order_price_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pre_order_price_approvals_authenticated" ON public.pre_order_price_approvals;
CREATE POLICY "pre_order_price_approvals_authenticated" ON public.pre_order_price_approvals FOR ALL USING (auth.uid() IS NOT NULL);

-- 订单关联到价格审批 — 用于审计追溯
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS price_approval_id uuid REFERENCES public.pre_order_price_approvals(id);

-- ===== 2026-04-08 RLS 加固（P1 安全审计修复） =====
-- 详见 supabase/migrations/20260408_rls_hardening.sql
CREATE OR REPLACE FUNCTION public.user_can_see_all_orders(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- 注意：role 是 user_role enum，必须 ::text 转换；roles 是 text[]/user_role[]，统一转 text[]
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = uid
      AND (
        role::text = ANY(ARRAY['admin','finance','admin_assistant','production_manager'])
        OR (roles IS NOT NULL AND roles::text[] && ARRAY['admin','finance','admin_assistant','production_manager'])
      )
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.user_can_access_order(uid uuid, oid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.user_can_see_all_orders(uid)
    OR EXISTS (SELECT 1 FROM public.orders WHERE id = oid AND (created_by = uid OR owner_user_id = uid))
    OR EXISTS (SELECT 1 FROM public.milestones WHERE order_id = oid AND owner_user_id = uid);
$$;

GRANT EXECUTE ON FUNCTION public.user_can_see_all_orders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_access_order(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "orders_select_all" ON public.orders;
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
DROP POLICY IF EXISTS "orders_select_v2" ON public.orders;
CREATE POLICY "orders_select_v2" ON public.orders FOR SELECT USING (
  auth.uid() IS NOT NULL AND (
    public.user_can_see_all_orders(auth.uid())
    OR created_by = auth.uid()
    OR owner_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.milestones WHERE order_id = orders.id AND owner_user_id = auth.uid())
  )
);

DROP POLICY IF EXISTS "milestones_select" ON public.milestones;
DROP POLICY IF EXISTS "milestones_select_v2" ON public.milestones;
CREATE POLICY "milestones_select_v2" ON public.milestones FOR SELECT USING (
  auth.uid() IS NOT NULL AND public.user_can_access_order(auth.uid(), order_id)
);

DROP POLICY IF EXISTS "order_attachments_select" ON public.order_attachments;
DROP POLICY IF EXISTS "order_attachments_select_v2" ON public.order_attachments;
CREATE POLICY "order_attachments_select_v2" ON public.order_attachments FOR SELECT USING (
  auth.uid() IS NOT NULL AND public.user_can_access_order(auth.uid(), order_id)
);

-- ===== 2026-04-08 AI Skills Phase 1 基础设施 =====
-- 详见 supabase/migrations/20260408_ai_skills_phase1.sql
CREATE TABLE IF NOT EXISTS public.ai_skill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name text NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_id text,
  input_hash text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}',
  output_result jsonb,
  source text NOT NULL DEFAULT 'rules' CHECK (source IN ('rules', 'rules+ai', 'cached', 'manual')),
  confidence_score integer CHECK (confidence_score IS NULL OR (confidence_score BETWEEN 0 AND 100)),
  confidence_level text CHECK (confidence_level IS NULL OR confidence_level IN ('high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'timeout', 'shadow')),
  duration_ms integer,
  error_message text,
  is_shadow boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  invalidated_at timestamptz,
  triggered_by text CHECK (triggered_by IS NULL OR triggered_by IN ('user', 'cron', 'event', 'manual')),
  triggered_user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_skill_runs_order_skill ON public.ai_skill_runs(order_id, skill_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_skill_runs_cache_lookup ON public.ai_skill_runs(skill_name, input_hash, expires_at) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_skill_runs_shadow ON public.ai_skill_runs(skill_name, is_shadow, created_at DESC) WHERE is_shadow = true;
ALTER TABLE public.ai_skill_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skill_runs_admin_select" ON public.ai_skill_runs;
CREATE POLICY "ai_skill_runs_admin_select" ON public.ai_skill_runs FOR SELECT USING (
  auth.uid() IS NOT NULL AND public.user_can_see_all_orders(auth.uid())
);
DROP POLICY IF EXISTS "ai_skill_runs_admin_insert" ON public.ai_skill_runs;
CREATE POLICY "ai_skill_runs_admin_insert" ON public.ai_skill_runs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.ai_skill_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.ai_skill_runs(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  action_payload jsonb NOT NULL DEFAULT '{}',
  executed_by uuid NOT NULL REFERENCES auth.users(id),
  executed_at timestamptz NOT NULL DEFAULT now(),
  rollback_available boolean NOT NULL DEFAULT false,
  rollback_until timestamptz,
  rollback_payload jsonb,
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_skill_actions_order ON public.ai_skill_actions(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_skill_actions_run ON public.ai_skill_actions(run_id);
ALTER TABLE public.ai_skill_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skill_actions_admin" ON public.ai_skill_actions;
CREATE POLICY "ai_skill_actions_admin" ON public.ai_skill_actions FOR ALL USING (
  auth.uid() IS NOT NULL AND public.user_can_see_all_orders(auth.uid())
);

CREATE TABLE IF NOT EXISTS public.ai_skill_circuit_state (
  skill_name text PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0,
  paused_until timestamptz,
  last_failure_at timestamptz,
  last_failure_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_skill_circuit_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_skill_circuit_state_admin" ON public.ai_skill_circuit_state;
CREATE POLICY "ai_skill_circuit_state_admin" ON public.ai_skill_circuit_state FOR ALL USING (
  auth.uid() IS NOT NULL AND public.user_can_see_all_orders(auth.uid())
);
