-- 报关主数据(2026-07-28 CEO 报关4件套):品类少→HS/报关品名建几十行全覆盖,生成时自动带出。
-- 幂等。
create table if not exists public.customs_hs_catalog (
  id uuid primary key default gen_random_uuid(),
  match_key text not null,            -- 匹配键:款号前缀或品名关键词(如 legging/文胸/夹克)
  hs_code text,
  customs_name text,                  -- 报关品名(如 女式针织裤)
  customs_spec text,                  -- 申报规格/成分要素
  unit text default '件',
  sort int default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.customs_hs_catalog enable row level security;
drop policy if exists customs_hs_catalog_all on public.customs_hs_catalog;
create policy customs_hs_catalog_all on public.customs_hs_catalog for all to authenticated using (true) with check (true);

-- 客户报关抬头(境外收货人/地址/税号)——一次录入,出运单证自动带出,不再每单手填
alter table public.customers add column if not exists consignee_name_en text;
alter table public.customers add column if not exists customs_address text;
alter table public.customers add column if not exists tax_no text;

-- 公司级报关默认值(港口/运输方式/监管方式/贸易国等,原烤死在代码)
create table if not exists public.customs_defaults (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.customs_defaults (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;
alter table public.customs_defaults enable row level security;
drop policy if exists customs_defaults_all on public.customs_defaults;
create policy customs_defaults_all on public.customs_defaults for all to authenticated using (true) with check (true);
