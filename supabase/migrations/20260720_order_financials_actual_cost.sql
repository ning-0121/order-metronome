-- ===== [2026-07-20] 冲90资金流:采购实付回流利润(独立实付列 + 录入率)=====
-- 全链审计 财务P1:利润用预算不用实付(采购实付从不回流)→ 亏损单被健康毛利掩盖。
-- 决策(用户拍板):加独立实付列 + 实付成本录入率;录入率够高才用实付算利润,否则用预算,不因数据不全把利润算高。
--   cost_material_actual  = 面料实付(LG台账 amount_incl_tax,order_id匹配) + 辅料实付(单订单PO对账 net_payable)
--   cost_actual_coverage  = 实付/预算 的录入率(0-1);profit.service 仅在 ≥0.8 时用实付,否则用预算。
-- 纯加法列,代码对列缺失优雅降级。
ALTER TABLE order_financials ADD COLUMN IF NOT EXISTS cost_material_actual numeric;
ALTER TABLE order_financials ADD COLUMN IF NOT EXISTS cost_actual_coverage numeric;
COMMENT ON COLUMN order_financials.cost_material_actual IS '采购实付料款(面料LG+辅料对账,RMB);录入率够高时 profit 用它替代预算';
COMMENT ON COLUMN order_financials.cost_actual_coverage IS '实付成本录入率=实付/预算(0-1);<0.8 视为数据不全,profit 回退预算';
