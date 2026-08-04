-- 补料申请(CEO 2026-08-04 定口径)
--
-- 业务链:生产部提请 → 带**谁的责任** + 上传**签字的责任认定书** → 采购审核 → 财务审核 → 方能补料
--
-- 【为什么新建对象,不塞进 procurement_tracking】
-- 那张是采购台账(一行一条料的到货跟踪),只有单个 approved_by_name/approved_at。
-- 补料申请有**自己的生命周期和两道审批**,塞进台账行会让「一条采购项」和「一次补料申请」
-- 糊成一个东西 —— 这个项目已经因为「同一件事两处各存一份」栽过好几次
-- (采购三表同名函数、PI 抬头两份副本)。
--
-- 🏛 Architecture Gate:属采购域;生产部拥有「提请」,采购与财务各拥有一道审批状态;
--    与 procurement_tracking.is_supplement(标记"这条采购项是补的")不重复 —— 那是结果,这是申请。
-- 🔮 Future Gate:责任认定 + 双审是标准做法,3 年后/10 个工厂都成立。
--
-- 【为什么责任方必填且不给默认值】
-- 财务契约 v1:liable_party 非 supplier/factory 时**不建扣款**。
-- 客户改单导致的补料 ≠ 工厂责任,填错就是冤枉供应商。所以 NOT NULL + CHECK,不许含糊。

create table if not exists public.material_resupply_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,

  -- 补什么
  material_name text not null,
  specification text,
  quantity numeric,
  unit text,
  reason text not null,                       -- 为什么要补

  -- 谁的责任(必填,决定财务建不建扣款)
  liable_party text not null
    check (liable_party in ('factory','supplier','customer','qimo','unknown')),
  liable_note text,                            -- 责任认定说明
  -- 签字的责任认定书:storage 路径数组。**没有凭证不许提交**(见 CHECK)
  evidence_paths jsonb not null default '[]'::jsonb,

  -- 流转状态
  status text not null default 'pending_procurement'
    check (status in ('pending_procurement','pending_finance','approved','rejected','cancelled')),

  requested_by uuid references auth.users(id),
  requested_by_name text,
  requested_at timestamptz not null default now(),

  procurement_reviewed_by uuid references auth.users(id),
  procurement_reviewed_by_name text,
  procurement_reviewed_at timestamptz,
  procurement_note text,

  finance_reviewed_by uuid references auth.users(id),
  finance_reviewed_by_name text,
  finance_reviewed_at timestamptz,
  finance_note text,

  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 提交时必须已带凭证:责任认定书是这条链的立身之本,空数组直接拒
  constraint material_resupply_evidence_required
    check (jsonb_array_length(evidence_paths) > 0)
);

create index if not exists idx_mrr_order on public.material_resupply_requests(order_id);
create index if not exists idx_mrr_status on public.material_resupply_requests(status);

comment on table public.material_resupply_requests is
  '补料申请:生产部提请→采购审核→财务审核。liable_party 决定财务是否建供应商扣款(契约 v1)。';
comment on column public.material_resupply_requests.evidence_paths is
  '签字的责任认定书(storage 路径)。CHECK 强制非空 —— 没有责任认定书就不该有补料申请。';
comment on column public.material_resupply_requests.liable_party is
  '责任方。factory/supplier → 财务建待扣款;customer/qimo/unknown → 不建。填错=冤枉供应商,故 NOT NULL。';

alter table public.material_resupply_requests enable row level security;

-- 读:能看该订单的人都能看(与订单可见性一致,不另造一套)
drop policy if exists mrr_select on public.material_resupply_requests;
create policy mrr_select on public.material_resupply_requests
  for select to authenticated using (true);

-- 写:一律走 server action(service-role),不开放给前端直连 —— 审批链必须在服务端把关
drop policy if exists mrr_no_client_write on public.material_resupply_requests;
create policy mrr_no_client_write on public.material_resupply_requests
  for all to authenticated using (false) with check (false);
