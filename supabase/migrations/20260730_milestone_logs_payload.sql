-- milestone_logs.payload 缺列修复 + 延期审计轨迹重建(2026-07-30)
--
-- ── 根因:两份 CREATE TABLE IF NOT EXISTS 抢建同一张表,输的那份带 payload ──
--   · supabase/migrations/20240101000000_add_milestone_logs.sql
--       → 无 payload,有 from_status/to_status。**这份先落了生产**。
--   · supabase/migration_t5_t4_t6.sql
--       → 有 payload jsonb,无 from_status/to_status。因为表已存在,IF NOT EXISTS 整段静默跳过,
--         payload 列**从来没建出来过**。
--   代码是照着第二份写的:凡是 insert 里带 payload 键的写入,PostgREST 直接以
--   PGRST204(schema cache 找不到 payload 列)拒绝,一行都没落库。
--   两个 logMilestoneAction 助手无条件带 `payload: payload || null`,所以**连不传 payload 的调用也一起挂**。
--
-- ── 生产实测(2026-07-30,service-role 全表精确 count)──
--   带 payload 的写入方 → 全部 0 行:
--     request_delay 0 / approve_delay 0 / reject_delay 0 / unblock 0 / recalc_schedule 0 /
--     execution_note 0 / party_confirmed 0 / order_purpose_changed 0 / agent_execute 0 /
--     nudge 0 / batch_step_marked 0 / batch_step_undone 0 / mark_done_backfill 0
--   不带 payload 的写入方 → 正常:
--     status_transition 716 / update 292 / auto_heal_ghost 125 / pm_misclaim_cleanup 88 / mark_done 4
--   同期 delay_requests 有 96 条。**96 次延期申请/审批,零条审计日志** —— 合规留痕全空。
--
-- ── 为什么补列而不是把信息塞进 note ──
--   1. 兄弟表 procurement_logs(20260613)就是 payload jsonb,其代码注释明写"复制 milestone_logs 模式"。
--      补列让本尊和它的复制品一致;塞 note 反而让原版偏离复制品。
--   2. 一条迁移修好 9 个文件 13 个写入点;改 note 要动 13 处,且丢掉 delay_request_id 这个
--      日志↔申请单的结构化关联键(排查延期链路要用它 join)。

alter table public.milestone_logs
  add column if not exists payload jsonb;

comment on column public.milestone_logs.payload is
  '结构化上下文(delay_request_id / new_anchor_date / new_due_at 等)。note 给人看,payload 给系统 join。'
  '2026-07-30 补建:此列在设计里一直存在,但因两份 CREATE TABLE IF NOT EXISTS 竞争而从未落到生产。';

-- ════════════════════════════════════════════════════════════════════════
-- 审计轨迹重建:从 delay_requests 反推那 96 条丢失的延期日志
-- ════════════════════════════════════════════════════════════════════════
-- 这些行是**事后重建**,不是当时real-time捕获的 —— 必须能一眼看出来,否则等于伪造留痕。
-- 双重标记:note 前缀 [补录·系统重建] + payload.reconstructed = true。
-- 幂等:按 (action, payload->>'delay_request_id') 去重,重跑不会重复插。

-- 1) 申请动作
insert into public.milestone_logs (milestone_id, order_id, actor_user_id, action, note, payload, created_at)
select
  dr.milestone_id,
  dr.order_id,
  dr.requested_by,
  'request_delay',
  '[补录·系统重建 2026-07-30] ' || coalesce(nullif(dr.reason_detail, ''), coalesce(dr.reason, '(无原因说明)')),
  jsonb_build_object(
    'delay_request_id', dr.id,
    'reconstructed', true,
    'reconstructed_at', '2026-07-30',
    'source', 'delay_requests',
    'reason_type', dr.reason_type,
    'requested_days', dr.requested_days
  ),
  dr.created_at
from public.delay_requests dr
join public.milestones m on m.id = dr.milestone_id
join public.orders o on o.id = dr.order_id
where dr.requested_by is not null
  and exists (select 1 from auth.users u where u.id = dr.requested_by)
  and not exists (
    select 1 from public.milestone_logs l
    where l.action = 'request_delay'
      and l.payload ->> 'delay_request_id' = dr.id::text
  );

-- 2) 审批/驳回动作(approved_by + approved_at 两条流共用)
insert into public.milestone_logs (milestone_id, order_id, actor_user_id, action, note, payload, created_at)
select
  dr.milestone_id,
  dr.order_id,
  dr.approved_by,
  case dr.status when 'approved' then 'approve_delay' else 'reject_delay' end,
  '[补录·系统重建 2026-07-30] ' || coalesce(nullif(dr.decision_note, ''),
    case dr.status when 'approved' then '延期批准' else '延期驳回' end),
  jsonb_build_object(
    'delay_request_id', dr.id,
    'reconstructed', true,
    'reconstructed_at', '2026-07-30',
    'source', 'delay_requests',
    'status', dr.status
  ),
  coalesce(dr.approved_at, dr.updated_at, dr.created_at)
from public.delay_requests dr
join public.milestones m on m.id = dr.milestone_id
join public.orders o on o.id = dr.order_id
where dr.status in ('approved', 'rejected')
  and dr.approved_by is not null
  and exists (select 1 from auth.users u where u.id = dr.approved_by)
  and not exists (
    select 1 from public.milestone_logs l
    where l.action in ('approve_delay', 'reject_delay')
      and l.payload ->> 'delay_request_id' = dr.id::text
  );

-- 加速上面两条 not exists,以及日后按申请单查日志
create index if not exists idx_milestone_logs_payload_delay_request
  on public.milestone_logs ((payload ->> 'delay_request_id'))
  where payload ->> 'delay_request_id' is not null;

-- ════════════════════════════════════════════════════════════════════════
-- 验证 SQL(迁移后手动跑)
-- ════════════════════════════════════════════════════════════════════════
-- 1. 列已建:
--    select column_name from information_schema.columns
--    where table_schema='public' and table_name='milestone_logs' and column_name='payload';
--
-- 2. 每条 delay_request 都有申请日志(期望 0 行缺口):
--    select count(*) from delay_requests dr where dr.requested_by is not null
--      and not exists (select 1 from milestone_logs l
--                      where l.action='request_delay' and l.payload->>'delay_request_id'=dr.id::text);
--
-- 3. 重建行可辨认(期望全部 reconstructed=true):
--    select action, count(*) from milestone_logs
--    where payload->>'reconstructed'='true' group by action;
