-- ===== [2026-07-21] 冲90资金流:佣金金额化(commission_amount)=====
-- 全链审计 财务P1:佣金停在"评分系数"(commission_rate 0.5~1.1),无应发金额→财务无法据此发放。
-- 决策(用户拍板):搭金额化框架,标准率可配置。
--   commission_amount = 佣金基数 × 标准佣金率 × 绩效系数(commission_rate)
--   默认:基数=订单成交额(RMB) · 标准率=1%(见 lib/domain/commission-config.ts,可改)
-- 纯加法列,代码对列缺失优雅降级。
ALTER TABLE order_commissions ADD COLUMN IF NOT EXISTS commission_amount numeric;
ALTER TABLE order_commissions ADD COLUMN IF NOT EXISTS commission_base numeric;
ALTER TABLE order_commissions ADD COLUMN IF NOT EXISTS commission_base_type text;
COMMENT ON COLUMN order_commissions.commission_amount IS '应发佣金金额(RMB)=基数×标准率×绩效系数';
COMMENT ON COLUMN order_commissions.commission_base IS '佣金基数(RMB,默认订单成交额)';
COMMENT ON COLUMN order_commissions.commission_base_type IS '基数口径:revenue(成交额)|profit(毛利)';
