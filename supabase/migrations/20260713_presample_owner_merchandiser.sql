-- ===== [2026-07-13] 产前样确认节点 owner 对齐:业务开发(sales) → 业务执行(merchandiser) =====
-- 背景:V2 模板(lib/milestoneTemplate.ts)已把「产前样确认」owner_role 定为 merchandiser(业务执行),
--   但更早模板建的老单存量仍是 sales(业务开发),徽章显示「业务」、责任错挂业务开发。
-- 口径依据 i18n 2026-07-10:sales=业务开发 / merchandiser=业务执行 / order_manager=业务执行经理。
-- 纯数据对齐,只动 step_key=pre_production_sample_approved 且当前 owner_role=sales 的行(幂等)。
-- 注:完成权限已在 milestonePerm 放开(业务执行经理 order_manager 可操作业务链节点),此处只修显示/归属。

update public.milestones
   set owner_role = 'merchandiser'
 where step_key = 'pre_production_sample_approved'
   and owner_role = 'sales';
