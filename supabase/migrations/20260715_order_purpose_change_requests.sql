-- ===== 20260715 订单用途变更审批流 =====
-- 背景:order_purpose(自产 production / 经销 trade / 委托 consign)原只在建单时能设,选错/历史遗留
--   永久卡住。补「改用途」入口:业务执行提请 → 财务或管理员一人审批 → 通过才落库(改用途 + 重算里程碑)。
-- 写操作全走 service-role 的 server action(动作层校验角色 + 记真实 auth.uid),故本表 RLS 仅需放行读。

create table if not exists public.order_purpose_change_requests (
  id            uuid primary key default uuid_generate_v4(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  from_purpose  text not null,
  to_purpose    text not null check (to_purpose in ('production','trade','consign')),
  reason        text null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by  uuid not null references auth.users(id),
  decided_by    uuid null references auth.users(id),
  decided_at    timestamptz null,
  decision_note text null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_opcr_order  on public.order_purpose_change_requests(order_id);
create index if not exists idx_opcr_status on public.order_purpose_change_requests(status);
-- 每单同时最多一条待审批(防重复提请)
create unique index if not exists uq_opcr_one_pending
  on public.order_purpose_change_requests(order_id) where status = 'pending';

alter table public.order_purpose_change_requests enable row level security;

-- 读:登录用户可读(动作层已按角色控制;审批需跨 owner 读)。写全走 service-role,绕 RLS。
drop policy if exists opcr_select on public.order_purpose_change_requests;
create policy opcr_select on public.order_purpose_change_requests
  for select using (auth.uid() is not null);

-- 验证:
--   select * from public.order_purpose_change_requests order by created_at desc limit 5;
