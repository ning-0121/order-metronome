-- ============================================================
-- 迁移运行器自举(2026-07-24)—— 只需在 Supabase SQL Editor 粘贴执行【一次】。
-- 之后 `npm run db:migrate` 会用 service-role 自动 apply supabase/migrations 里未执行的迁移。
--
-- 建两样东西:
--   1) _app_migrations  —— 记录哪些迁移文件已执行(防重复)。
--   2) exec_sql(text)   —— 让 service-role 客户端能执行任意 DDL(仅 service_role 可调,
--                          等价于本来就有 service-role key 的人的权限,不新增攻击面)。
-- ============================================================

create table if not exists public._app_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now(),
  statements  int
);

create or replace function public.exec_sql(sql text)
returns void
language plpgsql
security definer
set search_path = public
as $exec$
begin
  execute sql;
end;
$exec$;

-- 只有 service_role 能调(anon/authenticated/public 一律不能)
revoke all on function public.exec_sql(text) from public;
revoke all on function public.exec_sql(text) from anon;
revoke all on function public.exec_sql(text) from authenticated;
grant execute on function public.exec_sql(text) to service_role;
