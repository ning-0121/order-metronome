-- ===== 2026-07-24 包装归集(指定包装厂 + 逐批到货进度)=====
-- 场景:一张单裁片/车缝分散在多厂,成品陆续汇集到一个「包装归集厂」做最终包装/装箱。
-- 指定包装厂 + 逐批登记各厂到货(来源厂/款色/数量/到货日),系统算「已归集 vs 订单总量」,齐了才开包装。
-- 纯加法(两张新表),不影响现有流程。
-- 回滚:drop table if exists public.packaging_gather_records; drop table if exists public.packaging_consolidation;

-- 头表:一张单一条,指定包装归集厂 + 目标数量
create table if not exists public.packaging_consolidation (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  packing_factory text,                   -- 包装归集厂(最终包装/装箱在哪家)
  target_qty numeric,                      -- 目标总量(默认订单数量,可改)
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id)
);

-- 明细:各厂成品陆续到包装厂的逐批登记
create table if not exists public.packaging_gather_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  from_factory text not null,              -- 来自哪个厂(车缝厂/外发厂)
  item_desc text,                          -- 款色/描述(如「黑色 M」)
  qty numeric not null,                    -- 本批到货数量
  unit text default '件',
  arrived_date date,                       -- 到货日
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_pkg_consol_order on public.packaging_consolidation(order_id);
create index if not exists idx_pkg_gather_order on public.packaging_gather_records(order_id);

comment on table public.packaging_consolidation is '包装归集头:一张单指定一个包装归集厂 + 目标总量。';
comment on table public.packaging_gather_records is '包装归集明细:各厂成品陆续到包装厂的逐批到货登记;Σqty = 已归集,对比订单总量看齐没齐。';

-- RLS:与外发同口径,已登录可读写,角色门禁在 server action(EXECUTION)里挡。
alter table public.packaging_consolidation enable row level security;
alter table public.packaging_gather_records enable row level security;
drop policy if exists pc_all on public.packaging_consolidation;
drop policy if exists pgr_all on public.packaging_gather_records;
create policy pc_all on public.packaging_consolidation for all to authenticated using (true) with check (true);
create policy pgr_all on public.packaging_gather_records for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.packaging_consolidation to authenticated;
grant select, insert, update, delete on public.packaging_gather_records to authenticated;
