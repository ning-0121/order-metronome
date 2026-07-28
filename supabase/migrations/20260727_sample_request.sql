-- 打样申请单结构化字段(2026-07-27):新建样品单页改成「打样申请单」样式,
-- 样衣性质/面料1·2(含克重)/辅料1·2·3/特殊要求/贴样说明 无现成列 → 一个 jsonb 兜住。
-- 核心字段(客户/款式描述=product_description/款号=style_no/尺码=sizes/总数量=quantity)复用 orders 现列。
alter table public.orders add column if not exists sample_request jsonb;
comment on column public.orders.sample_request is '打样申请单结构化:{sample_nature, fabrics:[{name,gsm}], trims:[name], special_requirements, swatch_note}';
