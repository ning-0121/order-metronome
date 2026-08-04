-- QC 结论增加「返工」(CEO 2026-08-04:「返工是在 QC 报告中要求返工,然后返工后去重新验货」)
--
-- 原 CHECK 只有 pending/pass/fail/conditional —— 判「不合格」和判「要返工」被迫混成一个 fail,
-- 于是:① 分不清「这批废了」和「返工还能救」;② 返工费用向谁追偿无从锚定;
--       ③ 「返工后重新验货」没有触发点,全靠人记得再建一条检验。
--
-- inspection_type 里本来就有 're-inspection'(复检),所以复检不用新建类型 ——
-- 判 rework 时自动派一条复检任务给同一个 QC,链路就闭合了。
--
-- 与财务契约 v1 的关系:判 rework → 推 rework.recorded → 财务建待扣款(向供应商追偿返工费);
-- 复检合格 → 推 deduction.cancelled 撤销。与 qc.failed 同一套锚点规则(event_ref = QC-<id>)。

alter table public.qc_inspections
  drop constraint if exists qc_inspections_result_check;

alter table public.qc_inspections
  add constraint qc_inspections_result_check
  check (result = any (array['pending'::text, 'pass'::text, 'fail'::text, 'conditional'::text, 'rework'::text]));

-- 复检指回被返工的那次检验,便于「这批返了几次」追溯。可空(首检没有来源)。
alter table public.qc_inspections
  add column if not exists rework_of uuid references public.qc_inspections(id) on delete set null;

create index if not exists idx_qc_rework_of on public.qc_inspections(rework_of);

comment on column public.qc_inspections.rework_of is
  '本次复检针对哪一次检验的返工要求(CEO 2026-08-04)。可空=首检。用于追溯同一批返工次数。';
