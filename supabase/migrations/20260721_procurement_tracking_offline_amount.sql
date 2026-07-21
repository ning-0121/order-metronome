-- ===== [2026-07-21] 线下采购金额补录(喂实付回流)=====
-- 冲90资金流:线下采购的钱要能进「实付回流利润」。采购进度(procurement_tracking)此前无金额列。
--   amount        = 该物料线下采购实付金额(RMB)
--   offline_paid  = 是否已线下付款(=true 才计入 recomputeOrderActualCost 的实付,且不推财务、不与对账/台账重复)
-- 纯加法列,代码对列缺失优雅降级。
ALTER TABLE procurement_tracking ADD COLUMN IF NOT EXISTS amount numeric;
ALTER TABLE procurement_tracking ADD COLUMN IF NOT EXISTS offline_paid boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN procurement_tracking.amount IS '线下采购实付金额(RMB)';
COMMENT ON COLUMN procurement_tracking.offline_paid IS '已线下付款:true 才计入实付回流利润,不推财务';
