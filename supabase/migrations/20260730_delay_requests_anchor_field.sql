-- 整单延期「新出厂日」落库修复(2026-07-30)
--
-- 根因:delay_requests.proposed_new_anchor_date 被两条流复用,但语义不同 ——
--   · 整单延期 createOrderLevelDelayRequest  → 存的是新【出厂日】(factory_date)
--   · 节点延期 push_delivery                 → 存的是从 etd / warehouse_due_date 推算的新锚点
-- 而审批落地时一律按 incoterm 写 orders.etd(FOB) / orders.warehouse_due_date(DDP),**从不写 factory_date**。
-- FOB / 人民币单的单头只显示 factory_date(ETD/ETA 仅 DDP 显示)→ 整单延期批准后出厂日永远停在旧值。
--
-- 修:显式记录该锚点指向 orders 的哪一列,审批按它落库,两条流各自正确、互不污染。
-- anchor_field 为 null = 迁移前的老行,代码回退到历史行为(FOB→etd / DDP→warehouse_due_date),语义不变。

alter table public.delay_requests
  add column if not exists anchor_field text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delay_requests_anchor_field_chk') then
    alter table public.delay_requests
      add constraint delay_requests_anchor_field_chk
      check (anchor_field is null or anchor_field in ('factory_date', 'etd', 'warehouse_due_date'));
  end if;
end $$;

comment on column public.delay_requests.anchor_field is
  'proposed_new_anchor_date 指向 orders 的哪一列(factory_date / etd / warehouse_due_date)。'
  '创建延期申请时写死,审批落地按它更新订单。null = 迁移前老行,回退到按 incoterm 推断的历史行为。';
