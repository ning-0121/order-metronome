-- 20260710 每款支持多种布料:order_line_items 新增 fabrics JSONB 列(纯增量、可回滚)。
-- 形状:[{ material_id, name, width, consumption, unit, price }]
--   price = 采购参考单价(¥),只登记/带出参考,不参与自动成本核算(老板确认口径 2026-07-10)。
-- 向后兼容:旧的 fabric_name/width/consumption/unit 仍写「第一条布料」;
--   读取时优先 fabrics,缺则回退旧列合成单条。
-- 回滚:alter table public.order_line_items drop column if exists fabrics;

alter table public.order_line_items
  add column if not exists fabrics jsonb;

comment on column public.order_line_items.fabrics is
  '该款多种布料明细(富录入表 S1.2 多布料)。[{material_id,name,width,consumption,unit,price}]。price 为采购参考单价(¥),只登记不参与自动成本。第一条镜像到 fabric_* 旧列做兼容。';
