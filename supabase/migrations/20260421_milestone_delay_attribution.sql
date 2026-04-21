-- ===== 2026-04-21 里程碑延误归因 =====
-- 支持"逾期完成"的事后归因，配合 /admin/delay-hotspots
-- 目标：每条延误完成的关卡，被强制归类原因，供复盘 + 财务审计 + 员工考核

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS delay_reason_type text,       -- 'upstream' | 'customer_change' | 'internal' | 'force_majeure' | 'other'
  ADD COLUMN IF NOT EXISTS delay_reason_note text,
  ADD COLUMN IF NOT EXISTS delay_attributed_by text,     -- 归因人姓名
  ADD COLUMN IF NOT EXISTS delay_attributed_at timestamptz;

-- 索引：快速找未归因的逾期完成关卡
CREATE INDEX IF NOT EXISTS idx_milestones_delay_pending
  ON milestones(order_id, actual_at)
  WHERE actual_at IS NOT NULL AND delay_attributed_at IS NULL;

-- 枚举约束（软约束，不用 enum 类型以便后续扩展）
COMMENT ON COLUMN milestones.delay_reason_type IS
  '逾期归因：upstream(上游延误) / customer_change(客户变更) / internal(内部失误) / force_majeure(不可抗力) / other';
