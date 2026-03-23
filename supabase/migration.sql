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
