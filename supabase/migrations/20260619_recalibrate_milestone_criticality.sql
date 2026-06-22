-- ===== 20260619 节拍器关键性收敛:回填存量订单 milestones =====
-- 配合 lib/milestoneTemplate.ts:is_critical 收敛(24→10)+ 剩余物料回收/成品入库 去强制凭证。
-- 模板只影响【新单】;此回填让【存量生产订单】也生效(实测 134 单几乎全节点逾期+关键通胀)。
-- 仅 order_purpose='production';trade/sample 不动。纯改 is_critical/evidence_required 元数据,
--   不碰 status/日期/凭证内容。可重跑(幂等:is distinct from 守卫)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行,Claude 不执行。

-- 1) 降为非关键(对齐新模板)
update public.milestones m
set is_critical = false
from public.orders o
where m.order_id = o.id and o.order_purpose = 'production'
  and m.step_key in (
    'po_confirmed','order_kickoff_meeting','production_order_upload',
    'order_docs_bom_complete','bulk_materials_confirmed','processing_fee_confirmed',
    'factory_confirmed','pre_production_sample_ready','pre_production_sample_sent',
    'materials_received_inspected','packing_method_confirmed','customs_export',
    'finance_shipment_approval','finished_goods_warehouse'
  )
  and m.is_critical is distinct from false;

-- 2) 保持关键(幂等,通常已是 true)
update public.milestones m
set is_critical = true
from public.orders o
where m.order_id = o.id and o.order_purpose = 'production'
  and m.step_key in (
    'finance_approval','procurement_order_placed','pre_production_sample_approved',
    'production_kickoff','final_qc_check','factory_completion','inspection_release',
    'booking_done','shipment_execute','payment_received'
  )
  and m.is_critical is distinct from true;

-- 3) 低价值节点去强制凭证(剩余物料回收/成品入库,实测完成率 10-12%)
update public.milestones m
set evidence_required = false
from public.orders o
where m.order_id = o.id and o.order_purpose = 'production'
  and m.step_key in ('leftover_collection','finished_goods_warehouse')
  and m.evidence_required is distinct from false;

-- 验证:每个 step_key 的 is_critical 分布
--   select step_key, is_critical, count(*) from public.milestones m
--   join public.orders o on o.id=m.order_id where o.order_purpose='production'
--   group by step_key, is_critical order by step_key;
