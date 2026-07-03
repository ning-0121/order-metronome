-- ========================================================================
-- 补采购(Supplement Procurement)—— procurement_items 加补采购标记 + 财务审批门禁
-- ========================================================================
-- 背景(2026-07-03 用户需求):
--   ① 品类补:漏采的物料,业务执行在订单「原辅料」加行 → 核料归并出新采购项。
--      若订单已过「采购下单」节点,新项自动标记为补采购 → 需财务审批。
--   ② 数量补:生产中不够料,业务执行在「采购核料」对已有项提「补数量」申请
--      → 生成一条新采购项(同物料身份,数量=补量),标记补采购 → 需财务审批。
--   ③ 财务预警:补采购项创建即通知财务;财务批准后采购才能「确认→生成执行行→归单」。
--   采购部不自造需求:需求只能来自 BOM/核料(业务执行)。
-- 纯加法,不动现有行(默认 not_required = 原有项全不受影响)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS is_supplement            boolean NOT NULL DEFAULT false,  -- 补采购项
  ADD COLUMN IF NOT EXISTS supplement_reason        text,                            -- 补采购原因(必填于申请)
  ADD COLUMN IF NOT EXISTS supplement_base_item_id  uuid REFERENCES public.procurement_items(id) ON DELETE SET NULL, -- 数量补:基于哪一项
  ADD COLUMN IF NOT EXISTS supplement_requested_by  uuid,
  ADD COLUMN IF NOT EXISTS supplement_requested_at  timestamptz,
  ADD COLUMN IF NOT EXISTS finance_approval_status  text NOT NULL DEFAULT 'not_required'
    CHECK (finance_approval_status IN ('not_required','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS finance_approved_by      uuid,
  ADD COLUMN IF NOT EXISTS finance_approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS finance_reject_reason    text;

CREATE INDEX IF NOT EXISTS idx_pi_supplement_pending
  ON public.procurement_items(finance_approval_status)
  WHERE finance_approval_status = 'pending';

COMMENT ON COLUMN public.procurement_items.is_supplement IS
  '补采购项(品类补=采购下单后核料新增;数量补=对已有项申请加量)。需 finance_approval_status=approved 才能确认/执行。';

-- ========================================================================
-- 验证(执行后逐条跑,期望值见注释)
-- ========================================================================
-- ① 期望 9 行(新列都在):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='procurement_items' AND column_name IN
--  ('is_supplement','supplement_reason','supplement_base_item_id','supplement_requested_by',
--   'supplement_requested_at','finance_approval_status','finance_approved_by','finance_approved_at','finance_reject_reason');
-- ② 期望全部 not_required(存量项不受影响):
-- SELECT finance_approval_status, count(*) FROM public.procurement_items GROUP BY 1;

-- ========================================================================
-- 回滚
-- ========================================================================
-- ALTER TABLE public.procurement_items
--   DROP COLUMN IF EXISTS is_supplement, DROP COLUMN IF EXISTS supplement_reason,
--   DROP COLUMN IF EXISTS supplement_base_item_id, DROP COLUMN IF EXISTS supplement_requested_by,
--   DROP COLUMN IF EXISTS supplement_requested_at, DROP COLUMN IF EXISTS finance_approval_status,
--   DROP COLUMN IF EXISTS finance_approved_by, DROP COLUMN IF EXISTS finance_approved_at,
--   DROP COLUMN IF EXISTS finance_reject_reason;
