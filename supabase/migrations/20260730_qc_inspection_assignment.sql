-- QC 加查/上线审查:把 qc_inspections 从「事后台账」升级为「可委派的检验任务」(2026-07-30)
--
-- 需求(CEO):QC 独立成角色后,负责所有订单的 上线审查 / 中查 / 尾查 +【生产主管委派的加查】,并做报告。
--
-- 为什么不建新表(对象准入双门禁):
--   🏛 Architecture Gate —— 「一次检验」这个对象**已经存在**就是 qc_inspections:
--      order_id + 可空 milestone_id(天然支持脱离节点的临时检验)+ 一单可多条(无唯一约束)
--      + 检验结论(result / qty_pass / qty_fail / defect_details / evidence_urls)。
--      出运闸已经在读它(app/actions/milestones.ts),shipment_confirmations 也 FK 它。
--      再建 qc_tasks 会让「检验」出现第二个真相源,出运闸得查三张表。
--   🔮 Future Gate —— 加查天生是「一单 N 条、类型不定」,本表结构已经满足;
--      而用 milestones 做加查在结构上走不通:milestones 有 unique(order_id, step_key),
--      一单只能一条;用合成 key(extra_qc_1/2)会同时打挂 8 个 step_key 注册表,
--      且未注册的 key 在时间线上根本不渲染(即 [[v1-v2-stepkey-drift]] 那类事故)。
--
-- 数据所有权(两个写入方,按列切干净):
--   · 生产主管写【委派】列:assigned_to / assigned_by / assigned_at / due_date / assignment_note
--   · QC 写【结论】列:result / qty_* / defect_details / evidence_urls / notes / inspection_date
--   这与 lib/domain/checklist.ts 里已经确立的规则一致:主管委派加查,但不替 QC 填验货结论。
--
-- task_status 默认 'done':存量行都是"事后补记的已完成检验",默认值让它们语义不变,零回填。

alter table public.qc_inspections
  add column if not exists assigned_to     uuid references auth.users(id) on delete set null,
  add column if not exists assigned_by     uuid references auth.users(id) on delete set null,
  add column if not exists assigned_at     timestamptz,
  add column if not exists due_date        date,
  add column if not exists assignment_note text,
  add column if not exists task_status     text not null default 'done';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'qc_inspections_task_status_chk') then
    alter table public.qc_inspections
      add constraint qc_inspections_task_status_chk
      check (task_status in ('assigned', 'in_progress', 'done', 'cancelled'));
  end if;
end $$;

-- 放宽检验类型:补 line_start(上线审查)与 extra(主管委派的加查)。
-- 原枚举 ('mid','final','inline','re-inspection') 全部保留,存量行不受影响。
alter table public.qc_inspections drop constraint if exists qc_inspections_inspection_type_check;
alter table public.qc_inspections
  add constraint qc_inspections_inspection_type_check
  check (inspection_type in ('line_start', 'mid', 'final', 'inline', 're-inspection', 'extra'));

-- QC 查「派给我的活」;主管查某单的检验记录
create index if not exists idx_qc_inspections_assignee
  on public.qc_inspections (assigned_to, task_status, due_date);
create index if not exists idx_qc_inspections_order
  on public.qc_inspections (order_id, created_at desc);

comment on column public.qc_inspections.task_status is
  '检验任务状态:assigned=主管已派待做 / in_progress=QC 在做 / done=已出结论 / cancelled=取消。存量行默认 done。';
comment on column public.qc_inspections.assigned_to is
  '被委派的 QC(生产主管写)。为空=QC 自行发起的检验,非委派。';
