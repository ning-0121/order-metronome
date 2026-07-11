-- ============================================================
-- 20260711 物料「加工厂承担」标记 —— 第三种供料方式
-- 场景:有些辅料由加工厂承担费用(工厂自理/含在加工费里),绮陌不采购、不计成本(工厂承担),
-- 但要出现在生产任务单「辅料明细」里给生产照做、给财务监督加工厂付款。
-- 行为同「客供」(不采购+不计成本),区别只在生产任务单上标「加工厂承担」而非「客供」。
-- 与 customer_supplied 互斥(供料方式三选一:自购/客供/加工厂承担,app 层单选保证)。
-- 排除逻辑在 app 层:procurement-items 归并跳过(customer_supplied || factory_supplied)+
--   quote-baseline 面料/成本不计。纯加法可逆列,down 见同名 .down.sql。
-- ============================================================

ALTER TABLE public.materials_bom
  ADD COLUMN IF NOT EXISTS factory_supplied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.materials_bom.factory_supplied IS
  '加工厂承担:true=费用由加工厂承担、绮陌不采购不计成本(仅生产任务单辅料明细标注给生产/财务监督)。与 customer_supplied 互斥。默认 false。';
