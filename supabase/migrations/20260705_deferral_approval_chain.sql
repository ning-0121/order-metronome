-- ========================================================================
-- 节点改期 · 多级审批链(2026-07-05 · P1)
-- ========================================================================
-- 延期申请从"单人审批"扩展为"按部门路由的多级审批链"(见 lib/domain/deferral-routing.ts)。
-- 纯加法,给现有 delay_requests 补列;旧单人审批流不受影响(新列有默认值)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.delay_requests
  ADD COLUMN IF NOT EXISTS approval_chain   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 有序角色链快照 ['merchandiser','order_manager']
  ADD COLUMN IF NOT EXISTS approvals        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 已确认 [{role,user_id,name,at,note}]
  ADD COLUMN IF NOT EXISTS current_step     int  NOT NULL DEFAULT 0,             -- 当前轮到链上第几级(0基)
  ADD COLUMN IF NOT EXISTS reschedule_mode  text,                               -- push_delivery(退交期)/urgent(转紧急)
  ADD COLUMN IF NOT EXISTS block_root_cause text;                               -- 阻塞根因

COMMENT ON COLUMN public.delay_requests.approval_chain IS
  '改期审批链快照(建单时按 deferral-routing 冻结):有序角色,逐级确认;current_step 到 length = 全确认。';

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='delay_requests' AND column_name IN
--   ('approval_chain','approvals','current_step','reschedule_mode','block_root_cause');  -- 期望 5 行
-- 回滚:ALTER TABLE public.delay_requests DROP COLUMN approval_chain, ... (5 列)
-- ========================================================================
