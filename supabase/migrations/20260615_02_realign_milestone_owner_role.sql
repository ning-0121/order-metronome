-- ===== 20260615_02 在途订单里程碑 owner_role 对齐 2026 组织 =====
-- 把生产模板的 owner_role 调整（commit 2fc0ecc）同步到【在途订单的存量 pending 节点】：
--   PO后执行节点 sales→merchandiser(理单); 工厂生产节点 merchandiser→production(生产跟单);
--   工厂匹配 merchandiser→production_manager(生产主管); 业务中查/尾查 取消(删 pending)。
-- 只动活跃订单 + 未开始(pending)节点；in_progress/done 不碰(避免抢走在做的活)。
-- 已于 2026-06-15 在生产执行：守卫式，DELETE 硬卡 120，不符整体回滚。验证残留=0。
-- 本文件为 repo 存档。一次性守卫迁移：DELETE 硬卡 120，已执行过则不应重跑（重跑会因 0≠120 ABORT 回滚，安全）。

DO $$
DECLARE v_upd int; v_del int;
BEGIN
  create temp table _own_mig on commit drop as
  select s.id, (s.no_text)::user_role as new_owner
  from (
    select m.id, m.owner_role::text as cur,
      case m.step_key
        when 'order_kickoff_meeting'         then 'merchandiser'
        when 'production_order_upload'        then 'merchandiser'
        when 'pre_production_sample_sent'     then 'merchandiser'
        when 'pre_production_sample_approved' then 'merchandiser'
        when 'shipping_sample_send'           then 'merchandiser'
        when 'booking_done'                   then 'merchandiser'
        when 'customs_export'                 then 'merchandiser'
        when 'factory_confirmed'              then 'production_manager'
        else 'production'  -- pre_production_sample_ready / pre_production_meeting /
                           -- production_kickoff / mid_qc_check / final_qc_check /
                           -- factory_completion / leftover_collection
      end as no_text
    from public.milestones m
    join public.orders o on o.id = m.order_id
    where o.lifecycle_status not in ('completed','已完成','cancelled','已取消')
      and m.actual_at is null
      and (m.status::text is null or m.status::text in ('pending','未开始'))
      and m.step_key in ('order_kickoff_meeting','production_order_upload','pre_production_sample_sent',
        'pre_production_sample_approved','shipping_sample_send','booking_done','customs_export',
        'factory_confirmed','pre_production_sample_ready','pre_production_meeting','production_kickoff',
        'mid_qc_check','final_qc_check','factory_completion','leftover_collection')
  ) s
  where s.cur is distinct from s.no_text;

  update public.milestones m
  set owner_role = x.new_owner, updated_at = now()
  from _own_mig x where m.id = x.id;
  get diagnostics v_upd = row_count;

  delete from public.milestones m using public.orders o
  where o.id = m.order_id
    and o.lifecycle_status not in ('completed','已完成','cancelled','已取消')
    and m.actual_at is null
    and (m.status::text is null or m.status::text in ('pending','未开始'))
    and m.step_key in ('mid_qc_sales_check','final_qc_sales_check');
  get diagnostics v_del = row_count;

  -- 守卫：取消删除数必须 = dry-run 的 120，否则整体回滚
  if v_del <> 120 then
    raise exception 'ABORT: 取消删除=% (期望120)，已整体回滚', v_del;
  end if;

  raise notice '✅ owner_role 迁移 % 行；业务中/尾查取消删除 % 行（=120）', v_upd, v_del;
END $$;
