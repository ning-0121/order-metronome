-- ===== 2026-04-20 采购进度 — 补充采购申请流 =====
--
-- 在 procurement_tracking 表加 4 个字段，支持：
--   1. 区分"原始采购项"和"补充采购项"（is_supplement）
--   2. 采购人填写申请理由（supplement_reason）
--   3. 业务/管理员确认后留存审批人和时间（approved_by_name / approved_at）
--
-- 财务审计：supplement=true 的行展示完整审批链（谁申请、谁确认、何时确认）

ALTER TABLE procurement_tracking
  ADD COLUMN IF NOT EXISTS is_supplement    boolean     DEFAULT false,
  ADD COLUMN IF NOT EXISTS supplement_reason text,
  ADD COLUMN IF NOT EXISTS approved_by_name  text,
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz;

-- 索引：财务/管理员按"补充项"过滤时用
CREATE INDEX IF NOT EXISTS idx_procurement_tracking_supplement
  ON procurement_tracking(order_id, is_supplement, approved_at);
