-- ===== 2026-04-21 修复：加工费确认 owner_role 错配 =====
-- BUG: 模板 owner_role = 'production_manager'，但 SOP 明确写"财务审批加工费"
-- 导致财务用户点进加工费确认节点看不到"标记完成"按钮，只能催办
-- 案例：QM-20260403-011（年年旺 / 陈陈），方园财务无法处理

UPDATE milestones
SET owner_role = 'finance', updated_at = NOW()
WHERE step_key = 'processing_fee_confirmed'
  AND owner_role IN ('production_manager', 'production');

-- 日志
INSERT INTO milestone_logs (order_id, action, note)
SELECT order_id, 'fix_owner_role',
       '[模板修复] processing_fee_confirmed owner_role: production_manager → finance'
FROM milestones
WHERE step_key = 'processing_fee_confirmed' AND owner_role = 'finance'
  AND NOT EXISTS (
    SELECT 1 FROM milestone_logs l
    WHERE l.order_id = milestones.order_id AND l.action = 'fix_owner_role'
  );
