-- ===== 2026-04-21 客户节奏偏好（每个客户的自定义排期规则）=====
-- 场景：RAG 要求离厂前 1 天寄船样；慢客户要求产前样确认提前 2 周
-- 通用模板一刀切会错过客户习惯，加一层客户级覆盖
--
-- 结构示例：
-- {
--   "shipping_sample_send":        { "anchor": "factory_date", "offset_days": -1, "note": "RAG 习惯" },
--   "pre_production_sample_approved": { "anchor": "factory_date", "offset_days": -14 }
-- }
--
-- anchor 取值：
--   factory_date  — 离厂/ETD 锚点（最常用）
--   order_date    — 下单日（T0）
--   eta           — 到港日（DDP 专用）
-- offset_days：负数 = anchor 之前，正数 = anchor 之后

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS schedule_overrides jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN customers.schedule_overrides IS
  '按 step_key 映射的客户自定义节奏规则。优先级高于通用 TIMELINE。';
