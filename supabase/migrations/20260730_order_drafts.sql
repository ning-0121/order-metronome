-- 创建订单「保存草稿」(2026-07-30 用户提):填到一半有事离开,回来能接着填,换设备也能接着填。
--
-- 现状:只有 lib/order/create-order-resilience.ts 往 sessionStorage 写的**崩溃恢复**草稿,
-- 关掉标签页就没了、换设备更没有。这里加一张按用户存的草稿表,做成真正的"保存草稿"。
--
-- 存的是表单字段快照(与 serializeSafeOrderDraft 同结构:[[name, value], ...]),
-- 已在序列化时排除 file / password / secret / token / po_parse_snapshot,附件不进草稿。
--
-- ⚠ 2026-07-30 实测:生产库里已存在一张同名 order_drafts,但**只有 id 一列**、0 行、
--   没有任何迁移定义它、代码里也无人引用(疑似历史手动建表的残留)。
--   所以这里**不用整体 create table**(对已存在的表是 no-op,列永远补不上),
--   改成逐列 add column if not exists —— 无论表是新建还是那张残留表,结果都一致,且不删任何东西。

create table if not exists public.order_drafts (
  id uuid primary key default gen_random_uuid()
);

alter table public.order_drafts add column if not exists user_id    uuid;
alter table public.order_drafts add column if not exists label      text;
alter table public.order_drafts add column if not exists fields     jsonb       not null default '[]'::jsonb;
alter table public.order_drafts add column if not exists created_at timestamptz not null default now();
alter table public.order_drafts add column if not exists updated_at timestamptz not null default now();

-- user_id 外键 + 非空(表为空,加 not null 安全)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_drafts_user_id_fkey') then
    alter table public.order_drafts
      add constraint order_drafts_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

alter table public.order_drafts alter column user_id set not null;

create index if not exists order_drafts_user_updated_idx
  on public.order_drafts (user_id, updated_at desc);

alter table public.order_drafts enable row level security;

-- 草稿是私人未完成品:只有本人可见可改。没有跨用户共享的场景。
drop policy if exists order_drafts_own_select on public.order_drafts;
create policy order_drafts_own_select on public.order_drafts
  for select using (user_id = auth.uid());

drop policy if exists order_drafts_own_insert on public.order_drafts;
create policy order_drafts_own_insert on public.order_drafts
  for insert with check (user_id = auth.uid());

drop policy if exists order_drafts_own_update on public.order_drafts;
create policy order_drafts_own_update on public.order_drafts
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists order_drafts_own_delete on public.order_drafts;
create policy order_drafts_own_delete on public.order_drafts
  for delete using (user_id = auth.uid());

comment on table public.order_drafts is
  '创建订单未提交的草稿(按用户,跨设备)。fields 为表单字段快照,不含附件/密钥类字段。订单一旦创建成功即删除对应草稿。';
