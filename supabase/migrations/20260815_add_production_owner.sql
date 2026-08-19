-- 生产跟单:订单级字段(2026-08-15 CEO 拍板「先 B 后 A」)
--
-- 背景:此前「生产跟单是谁」完全寄生在 owner_role='production' 的里程碑上。
-- 实测 80 张在办生产单里 42 张(53%)用的是旧版模板,压根没有生产部门线节点 →
-- 系统里**没有任何位置**能记下这张单的生产跟单是谁,点「指派」必然失败。
--
-- B 方案(本次):加一个订单级字段,让「派人」和「有没有节点」解耦 —— 先能派上人、能追责。
-- A 方案(后续):给这些单补生产部门线节点,让生产部有活可考核。B 不替代 A。
--
-- 纯 additive:只 add column + index,不改任何既有列语义,不迁移任何数据。
alter table public.orders
  add column if not exists production_owner_user_id uuid;

comment on column public.orders.production_owner_user_id is
  '生产跟单(订单级)。旧模板订单没有 owner_role=production 的节点,无处记录负责人,故落在订单上。有生产节点的订单仍以节点 owner_user_id 为准,此列为兜底。';

create index if not exists idx_orders_production_owner
  on public.orders (production_owner_user_id)
  where production_owner_user_id is not null;
