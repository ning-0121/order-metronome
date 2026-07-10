-- ============================================================
-- 20260710 多方确认节点免凭证(用户拍板)
-- 新的「多方确认」节点(PO确认/产前样确认/尾期验货/发货出运)= 各方确认即完成,
-- 不再强制上传凭证。模板已改 evidence_required=false(新单生效);此迁移把库里
-- 存量在产订单的这四个节点也刷成免凭证,否则老单仍卡「需要凭证」。
-- 只动这四个 step_key,不碰其它节点。仅未完成节点(done 的已过,无需动)。可安全重跑。
-- 关联:lib/domain/confirmationParties.ts(多方确认配置)、lib/milestoneTemplate.ts。
-- ============================================================

UPDATE public.milestones
SET evidence_required = false
WHERE step_key IN ('po_confirmed', 'pre_production_sample_approved', 'final_qc_sales_check', 'shipment_execute')
  AND evidence_required IS DISTINCT FROM false;
