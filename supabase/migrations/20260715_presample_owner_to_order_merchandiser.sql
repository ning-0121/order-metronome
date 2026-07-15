-- ===== [2026-07-15] 产前样确认责任人 → 业务执行本人(不再是采购默认人 Helen) =====
-- 现象:USA 等老单产前样确认责任人挂着 Helen(王海莲)。
-- 根因:产前样确认早先 owner_role='procurement'(错),自动认领按 DEFAULT_ASSIGNEES 把它指给了采购默认人 Helen;
--   20260714 只把 owner_role 改回 merchandiser + 补了「未分配」的,已指派给 Helen 的 owner_user_id 没动。
-- 正解:「业务执行本人」= 该订单其它 owner_role='merchandiser' 节点的负责人。把产前样对齐到它,和这单其余业务节点同一个人。
-- 新单无碍:模板产前样已是 merchandiser,建单时随其它业务节点默认归建单人(业务执行本人)。

update public.milestones m
   set owner_user_id = sub.uid
  from (
    select distinct on (order_id) order_id, owner_user_id as uid
      from public.milestones
     where owner_role = 'merchandiser'
       and owner_user_id is not null
       and step_key <> 'pre_production_sample_approved'
     order by order_id, sequence_number
  ) sub
 where m.order_id = sub.order_id
   and m.step_key = 'pre_production_sample_approved'
   and m.owner_user_id is distinct from sub.uid;
