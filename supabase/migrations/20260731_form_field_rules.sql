-- 建单表单字段规则的覆盖层(2026-07-31,L2 第二步)
--
-- 代码默认在 lib/domain/formRules.ts 的 ORDER_CREATE_RULES;本表只存**覆盖**。
-- 解析顺序:代码默认 → global 覆盖 → 客户覆盖(见 resolveOrderFormRules)。
-- 表为空 = 完全等于代码默认 = 现在的线上行为,所以本迁移落地当天零变化。
--
-- 为什么 visible / required 是 nullable:
--   null = 「这一项不覆盖,沿用代码默认」。若用 not null default,配置一个字段的 required
--   就会连带把 visible 也钉死成默认值,以后改代码默认对它再也不生效 —— 覆盖层会悄悄变成第二真相源。
--   nullable 才能表达"只覆盖我关心的那一项"。
--
-- 为什么不做成"每个字段一行全量配置":
--   那样新增字段必须同时插一行,漏插就等于该字段被配没了(visible=false 的语义歧义)。
--   只存差异 → 代码是基准,配置是补丁,新增字段自动继承默认。

create table if not exists public.form_field_rules (
  id            uuid primary key default gen_random_uuid(),
  form_key      text not null default 'order_create',
  field_name    text not null,
  -- 'global' = 本部署统一;'customer' = 指定客户单独覆盖(scope_id = customers.id)
  scope         text not null default 'global',
  scope_id      uuid,
  visible       boolean,          -- null = 不覆盖
  required      boolean,          -- null = 不覆盖
  default_value text,             -- null = 不覆盖
  note          text,             -- 给配置的人自己看的备注(为什么这么配)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'form_field_rules_scope_chk') then
    alter table public.form_field_rules
      add constraint form_field_rules_scope_chk check (scope in ('global', 'customer'));
  end if;
  -- customer 作用域必须指明是哪个客户;global 则不能带 scope_id,否则语义含混
  if not exists (select 1 from pg_constraint where conname = 'form_field_rules_scope_id_chk') then
    alter table public.form_field_rules
      add constraint form_field_rules_scope_id_chk
      check ((scope = 'customer' and scope_id is not null) or (scope = 'global' and scope_id is null));
  end if;
end $$;

-- 同一(表单,字段,作用域)只能有一条覆盖。scope_id 为 null 时 unique 不生效,
-- 所以 global 和 customer 分开建两个部分唯一索引。
create unique index if not exists form_field_rules_global_uniq
  on public.form_field_rules (form_key, field_name) where scope = 'global';
create unique index if not exists form_field_rules_customer_uniq
  on public.form_field_rules (form_key, field_name, scope_id) where scope = 'customer';

create index if not exists form_field_rules_lookup
  on public.form_field_rules (form_key, scope, scope_id);

alter table public.form_field_rules enable row level security;

-- 读:所有登录用户 —— 建单表单要靠它决定渲染成什么样,不给读表单就没法画。
-- 表里没有任何敏感数据(只有字段名和三个开关)。
drop policy if exists form_field_rules_read on public.form_field_rules;
create policy form_field_rules_read on public.form_field_rules
  for select using (auth.uid() is not null);

-- 写:仅 admin。改这张表等于改所有人的建单表单,收敛到管理员。
drop policy if exists form_field_rules_write on public.form_field_rules;
create policy form_field_rules_write on public.form_field_rules
  for all using (public.is_admin_user(auth.uid())) with check (public.is_admin_user(auth.uid()));

comment on table public.form_field_rules is
  '建单表单字段规则的覆盖层。代码默认在 lib/domain/formRules.ts,本表只存差异;'
  'visible/required/default_value 为 null 表示该项不覆盖。表为空 = 代码默认行为。';
