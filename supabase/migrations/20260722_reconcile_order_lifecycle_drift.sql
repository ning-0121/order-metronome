-- ════════════════════════════════════════════════════════════════════════
-- 2026-07-22 — 修复 schema 漂移：20240121000000_add_order_lifecycle.sql 仅部分落地
--
-- 背景（生产 anon REST 实测）：
--   orders.lifecycle_status ✓ / orders.retrospective_completed_at ✓ 存在，
--   但 orders.terminated_at ✗ / termination_type ✗ 等未落地。
--   根因：原迁移把这些列和一组 CHECK 约束（lifecycle_status 只允许中文枚举、
--   completed 订单必须 terminated_at not null）打包在一起；后来 2026-05-15
--   normalize 把 lifecycle_status 归一成英文 'completed'，与那些 CHECK 冲突，
--   所以当年只手工挑了部分列执行 → 漂移。
--
-- 后果（两处静默 42703）：
--   1) daily-tasks.service generateRetrospectiveTasks 查 terminated_at
--      → 复盘待办对全员从未生成过。
--   2) ordersRepo cancel-approve / terminate 路径写 termination_type /
--      termination_reason / termination_approved_by，读 retrospective_required
--      → 正式取消审批 / 结案流程写库报错。
--
-- 本迁移：
--   - 幂等补齐缺失列（ADD COLUMN IF NOT EXISTS），已存在的列自动跳过。
--   - **不重建**原迁移的 CHECK 约束（会与英文 lifecycle 枚举冲突，正是当年漂移之源）。
--   - 回填 terminated_at：以里程碑最晚 actual_at 为完成信号，兜底 orders.updated_at
--     （只依赖必然存在的列，回填自身不会 42703）。
--
-- 单一真相：terminated_at = 订单终结时间（完成 / 取消）；此后由应用在终结时写入
--          （app/actions/orders.ts、lib/repositories/ordersRepo.ts、
--           lib/agent/systemGuardian.ts 已同步补写）。
--
-- 回滚：这些列 nullable、无约束，保留无害；无需回滚。
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. 幂等补齐 lifecycle 列族（不带 CHECK 约束）──────────────────────────
alter table public.orders add column if not exists activated_at timestamptz null;
alter table public.orders add column if not exists terminated_at timestamptz null;
alter table public.orders add column if not exists termination_type text null;
alter table public.orders add column if not exists termination_reason text null;
alter table public.orders add column if not exists termination_approved_by uuid null
  references auth.users(id);
alter table public.orders add column if not exists retrospective_required boolean not null default true;
-- retrospective_completed_at 生产已存在；幂等兜底，保持与原迁移一致
alter table public.orders add column if not exists retrospective_completed_at timestamptz null;

-- ── 2. 回填 terminated_at ────────────────────────────────────────────────
-- 已终结但 terminated_at 为空的订单：取该订单里程碑最晚的 actual_at 作为完成时间，
-- 无里程碑完成时间则用 orders.updated_at 兜底。覆盖中英文两套终结枚举。
update public.orders o
set terminated_at = coalesce(
  (
    select max(m.actual_at)
    from public.milestones m
    where m.order_id = o.id
      and m.status in ('done', '已完成', 'completed')
  ),
  o.updated_at
)
where o.terminated_at is null
  and o.lifecycle_status in (
    'completed', 'cancelled', 'archived',
    '已完成', '已取消', '已归档', '待复盘', '已复盘'
  );

COMMIT;

-- ── 验证 SQL（迁移后手动跑）─────────────────────────────────────────────
-- 1. 确认列已存在：
--    select column_name from information_schema.columns
--    where table_name='orders' and column_name in
--    ('terminated_at','termination_type','termination_reason',
--     'termination_approved_by','retrospective_required','activated_at');
-- 2. 确认回填覆盖率（终结单应几乎都非空）：
--    select lifecycle_status,
--           count(*) filter (where terminated_at is not null) as filled,
--           count(*) as total
--    from orders
--    where lifecycle_status in ('completed','cancelled','archived','已完成','已取消','已归档','待复盘','已复盘')
--    group by lifecycle_status;
