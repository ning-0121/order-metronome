-- ===== 2026-07-09 出货单据支持分批出货 =====
-- packing_lists 关联到具体出货批次(shipment_batches):
--   batch_id NULL  = 整单(非分批)出货单据
--   batch_id 有值  = 该批次专属的装箱单/PL/CI/报关(各批各自实发数量、各自一套单据)
-- 每批一张 packing_list;packing_list_lines 挂其下不变。
ALTER TABLE public.packing_lists
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.shipment_batches(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_packing_lists_batch ON public.packing_lists(batch_id);

-- 回滚:
-- DROP INDEX IF EXISTS public.idx_packing_lists_batch;
-- ALTER TABLE public.packing_lists DROP COLUMN IF EXISTS batch_id;
