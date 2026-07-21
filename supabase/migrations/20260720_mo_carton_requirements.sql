-- ===== [2026-07-20] 生产任务单「装箱要求」字段对齐订单资料表模板 =====
-- 订单资料表模板(LU21-SET 上衣)第 B22 行「装箱要求」此前系统硬编码为空、永远填不上。
-- 新增自由文本列,供「工厂执行说明」表单录入(如「一箱装10个配比中包」),导出时填入 B22。
-- 纯加法列,代码对列缺失优雅降级(先合不阻断,执行本 migration 后即生效)。
ALTER TABLE manufacturing_orders ADD COLUMN IF NOT EXISTS carton_requirements text;
