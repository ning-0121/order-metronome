-- ===== 2026-07-25 部门执行考核记录 department_assessments(CEO:采购/生产/QC 中心的活也要考核)=====
-- 病根:考核只按 milestones.owner_user_id 打分,V2 主时间线无 owner_role=procurement/production/qc 的节点 →
--   采购(Helen/Edward/王一品)、生产QC(骆淑娟等)在采购中心/生产中心干活,但那些活不生成里程碑 → 零被考核。
-- B 方案:关键中心动作(采购下单/收货验收/生产完成/QC验货)生成一条考核记录,记【目标日 vs 实际日 → 是否准时】,
--   评分引擎据此给采购/生产/QC 各出分卡。一单一部门一任务一行(幂等 upsert)。
-- 回滚:drop table if exists public.department_assessments;

create table if not exists public.department_assessments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  department text not null,          -- 'procurement' | 'production' | 'qc'
  user_id uuid,                      -- 实际执行人(该活是谁干的)
  task_key text not null,            -- 'bulk_po_placed' | 'goods_received' | 'production_done' | 'qc_passed' 等
  task_label text,                   -- 展示名
  target_date date,                  -- 目标日(取相关里程碑 due / 交期)
  actual_date date,                  -- 实际完成日
  on_time boolean,                   -- actual_date <= target_date(缺目标日则 null=不计入准时率)
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, department, task_key)
);

create index if not exists idx_dept_assess_order on public.department_assessments(order_id);
create index if not exists idx_dept_assess_user on public.department_assessments(user_id);

comment on table public.department_assessments is
  '部门执行考核(CEO 2026-07-25):采购/生产/QC 中心关键动作的准时考核记录,喂评分。一单一部门一任务一行。';

alter table public.department_assessments enable row level security;
drop policy if exists da_all on public.department_assessments;
create policy da_all on public.department_assessments for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.department_assessments to authenticated;
