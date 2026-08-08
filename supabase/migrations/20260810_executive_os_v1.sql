-- Executive OS V1 · Thin Slice 1 —— CEO Delegation Loop(2026-08-10)
--
-- 三层语义严格分离(CEO 6 点修正①):
--   executive_captures        = raw CEO 输入(永不被 AI/确认覆盖)
--   executive_capture_items   = AI interpretation(草案,待确认)
--   executive_delegations     = CEO confirmation 后的**唯一真相源**(跨日/延期/返工)
-- daily_tasks/notifications 是投影,禁止反向;TS1 员工端直读 delegations(修正⑥)。
-- 写一律 service-role Business Command(无 INSERT/UPDATE 策略);读按角色。纯新增,回滚 drop cascade。

-- ── 1. executive_captures ──
create table if not exists public.executive_captures (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  source_type text not null default 'text'
    check (source_type in ('text','voice','mail','file')),
  raw_text text,
  raw_audio_path text,                 -- Voice 第二步预留(TS1 空)
  transcript text,                     -- Voice 第二步预留(TS1 空)
  content_hash text,                   -- 内容指纹(sha256 raw_text):仅识别"同内容",非防重放
  idempotency_key text,                -- 修正②:command/request 级防 API retry 重复创建
  processing_status text not null default 'captured'
    check (processing_status in ('captured','parsing','parsed','confirmed','discarded')),
  metadata jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_exec_captures_actor on public.executive_captures(actor_user_id, captured_at desc);
create index if not exists idx_exec_captures_hash on public.executive_captures(content_hash);
create unique index if not exists uq_exec_captures_idem on public.executive_captures(idempotency_key) where idempotency_key is not null;

-- ── 2. executive_capture_items ──
create table if not exists public.executive_capture_items (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references public.executive_captures(id) on delete cascade,
  item_type text not null
    check (item_type in ('fact','proposed_delegation','constraint','risk')),
  structured_payload jsonb not null,
  confidence numeric(3,2),
  source_start int, source_end int,
  confirmation_status text not null default 'pending'
    check (confirmation_status in ('pending','confirmed','edited','rejected')),
  confirmed_by uuid, confirmed_at timestamptz,
  spawned_delegation_id uuid,          -- 确认后回填
  created_at timestamptz not null default now()
);
create index if not exists idx_exec_items_capture on public.executive_capture_items(capture_id);

-- ── 3. executive_delegations(唯一真相源)──
create table if not exists public.executive_delegations (
  id uuid primary key default gen_random_uuid(),
  -- 修正①:三层显式溯源,不复用 decision_id
  source_capture_id uuid references public.executive_captures(id),
  source_capture_item_id uuid references public.executive_capture_items(id),
  title text not null,
  instruction text not null,
  why text,
  owner_user_id uuid not null,
  reviewer_user_id uuid,
  -- 修正④:deadline 三元(绝对时刻 + 时区 + 原文 + 解析置信度);确认卡固化前须显示绝对时间
  deadline timestamptz,
  deadline_tz text default 'Asia/Shanghai',
  deadline_source_text text,
  deadline_confidence numeric(3,2),
  priority int not null default 3 check (priority in (1,2,3)),
  acceptance_criteria text,
  constraints jsonb,                   -- [{type:'min_margin',value:15,restrict:'send'}]
  -- 修正③:对手方(Gregory 未入库)—— 存名字 + 可空 id + 解析状态,禁 AI 自动建客户
  counterparty_name text,
  counterparty_id uuid,
  entity_resolution_status text default 'none'
    check (entity_resolution_status in ('none','tentative','resolved')),
  delegation_status text not null default 'confirmed'
    check (delegation_status in
      ('confirmed','assigned','accepted','in_progress','submitted','verifying',
       'verified','blocked','overdue','rework','cancelled','needs_ceo')),
  submitted_at timestamptz,
  submission_summary text,
  submission_artifact_refs jsonb,
  linked_order_id uuid,                -- 验证读利润用(员工提交时绑定)
  verification_status text check (verification_status in ('pending','pass','fail','need_info')),
  verification_result jsonb,           -- {margin_pct, threshold, source:'order_financials'}
  verification_reason text,
  verified_by uuid, verified_at timestamptz,
  confirmed_by uuid, confirmed_at timestamptz,   -- 修正①:CEO 确认层
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_exec_deleg_owner on public.executive_delegations(owner_user_id, delegation_status);
create index if not exists idx_exec_deleg_status_due on public.executive_delegations(delegation_status, deadline);
create index if not exists idx_exec_deleg_capture on public.executive_delegations(source_capture_id);

-- ── RLS ──
alter table public.executive_captures enable row level security;
alter table public.executive_capture_items enable row level security;
alter table public.executive_delegations enable row level security;

drop policy if exists exec_cap_sel on public.executive_captures;
create policy exec_cap_sel on public.executive_captures for select using (
  actor_user_id = auth.uid()
  or exists (select 1 from public.profiles p where p.user_id = auth.uid()
             and (p.role = 'admin' or 'admin' = any(p.roles)))
);

drop policy if exists exec_item_sel on public.executive_capture_items;
create policy exec_item_sel on public.executive_capture_items for select using (
  exists (select 1 from public.executive_captures c where c.id = capture_id and (
    c.actor_user_id = auth.uid()
    or exists (select 1 from public.profiles p where p.user_id = auth.uid()
               and (p.role = 'admin' or 'admin' = any(p.roles)))))
);

drop policy if exists exec_deleg_sel on public.executive_delegations;
create policy exec_deleg_sel on public.executive_delegations for select using (
  owner_user_id = auth.uid() or reviewer_user_id = auth.uid() or created_by = auth.uid()
  or exists (select 1 from public.profiles p where p.user_id = auth.uid()
             and (p.role = 'admin' or 'admin' = any(p.roles)))
);
-- 无 INSERT/UPDATE 策略:仅 service-role(Business Command)可写 —— 守 R1 边界

comment on table public.executive_delegations is
  'Executive OS V1 CEO 委托唯一真相源(2026-08-10)。daily_tasks/notifications 是其投影,禁止反向。';
