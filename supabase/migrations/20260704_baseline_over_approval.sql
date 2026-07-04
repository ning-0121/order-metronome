-- ========================================================================
-- 超报价基线 · 财务审批闸(2026-07-04 · P2b)
-- ========================================================================
-- 用户拍板:核料大货单耗 > 报价单耗,或 采购单价 > 报价单价(容差 0),
-- 该采购项**必须先经财务审批**才能确认/下单(卡风险不走流程)。
-- 复用「补采购财务审批」同款范式:给 procurement_items 加超基线审批维度列。
-- 纯加法。⚠️ 由人手动在 Supabase SQL Editor 执行。

ALTER TABLE public.procurement_items
  ADD COLUMN IF NOT EXISTS baseline_over_status       text,         -- null/pending/approved/rejected
  ADD COLUMN IF NOT EXISTS baseline_over_note         text,         -- 超了什么(大货单耗超+X% / 采购价超+Y%)
  ADD COLUMN IF NOT EXISTS baseline_over_requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS baseline_over_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS baseline_over_approved_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS baseline_over_approved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS baseline_over_reject_reason text;

COMMENT ON COLUMN public.procurement_items.baseline_over_status IS
  '超报价基线财务审批:null=未超/未触发 · pending=待财务审批 · approved=已批准可确认 · rejected=已驳回。确认闸见 updateProcurementItemStatus。';

-- ========================================================================
-- 验证:期望 7 行
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='procurement_items' AND column_name LIKE 'baseline_over%';
-- ========================================================================
-- 回滚:ALTER TABLE public.procurement_items DROP COLUMN baseline_over_status, ... (7 列)
-- ========================================================================
