-- ===== 2026-07-25 统一评分申诉 score_appeals(CEO 批准的评分制度 Q3)=====
-- 一张表覆盖三类申诉:po_overdue(PO逾期罚款)/ node_overdue(节点逾期扣分)/ quality(质量扣分)。
-- 证据必传;域路由审批(业务经理/生产主管/采购经理;PO 另需财务会签;老板可单方 override)。
-- 通过后:评分函数据"已批准申诉"豁免对应扣分(node→不扣准时分;quality→恢复质量分;po→免罚)。
-- 回滚:drop table if exists public.score_appeals;

create table if not exists public.score_appeals (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  appeal_type text not null,              -- 'po_overdue' | 'node_overdue' | 'quality'
  milestone_id uuid references public.milestones(id) on delete set null,  -- node/quality 指向的节点;po 为 null
  target_key text,                        -- quality: mid_qc_check/final_qc_check;node: step_key(可空)
  reason_category text not null,          -- 'customer' | 'supplier' | 'force_majeure' | 'system' | 'other'
  reason text not null,                   -- 申诉说明
  evidence_urls jsonb not null default '[]'::jsonb,  -- 证据文件 URL(必传 ≥1,action 层强校验)
  status text not null default 'pending', -- pending | approved | rejected
  reviewer_role text,                     -- 该走谁审(order_manager/production_manager/procurement_manager)
  reviewer_decision text,                 -- approved | rejected | null(一审:域经理)
  finance_decision text,                  -- approved | rejected | null(仅 po_overdue 需财务会签)
  admin_override text,                    -- approved | rejected | null(老板单方,优先)
  decision_note text,
  submitted_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_score_appeals_order on public.score_appeals(order_id);
create index if not exists idx_score_appeals_status on public.score_appeals(status) where status = 'pending';

comment on table public.score_appeals is '统一评分申诉(CEO 批 2026-07-25):PO逾期/节点逾期/质量三类扣分申诉,证据必传+域路由审批;通过后评分豁免对应扣分。';

alter table public.score_appeals enable row level security;
drop policy if exists sa_all on public.score_appeals;
create policy sa_all on public.score_appeals for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.score_appeals to authenticated;
