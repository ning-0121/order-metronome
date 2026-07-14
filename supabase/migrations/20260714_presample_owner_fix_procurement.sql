-- ===== [2026-07-14] 产前样确认 owner 再对齐:采购(procurement)等 → 业务执行(merchandiser) =====
-- 现象:订单 1022946 产前样确认 owner_role='procurement',责任人显示「采购/跨部门」,
--   业务执行(陈陈=merchandiser)完成不了(完成闸 merchandiser 不匹配 procurement),节点卡住。
-- 根因:模板里产前样确认一直是 merchandiser(业务执行),此单旧数据/导入错挂成采购。
-- 采购只是该节点的「确认方」(原辅料品质),不是责任方。
-- 上条 20260713 只改了 owner_role='sales' 的,没覆盖 procurement,本条兜底所有非 merchandiser。

-- 1) 强制对齐 owner_role 到模板口径(业务执行)。产前样确认按模板恒为 merchandiser,故 catch 一切非 merchandiser。
update public.milestones
   set owner_role = 'merchandiser'
 where step_key = 'pre_production_sample_approved'
   and owner_role is distinct from 'merchandiser';

-- 2) 未分配的产前样确认 → 归到「订单业务负责人」(owner_user_id 优先,否则建单人),
--    且该人须是业务侧角色(防订单被非业务账号建时错挂)。这样责任人显示真人(如陈陈),计分/催办有的放矢。
update public.milestones m
   set owner_user_id = coalesce(o.owner_user_id, o.created_by)
  from public.orders o
  join public.profiles p on p.user_id = coalesce(o.owner_user_id, o.created_by)
 where m.order_id = o.id
   and m.step_key = 'pre_production_sample_approved'
   and m.owner_user_id is null
   and coalesce(o.owner_user_id, o.created_by) is not null
   and (p.role in ('sales','merchandiser','sales_manager','order_manager')
        or p.roles && array['sales','merchandiser','sales_manager','order_manager']);
