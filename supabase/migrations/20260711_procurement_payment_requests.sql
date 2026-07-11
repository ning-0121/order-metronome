-- ========================================================================
-- 采购付款申请(2026-07-11,P2)—— 对账确认后,采购每周分批、自定义金额提交给财务
-- ========================================================================
-- 一张对账单(procurement_reconciliations)可挂多笔付款申请,每笔采购自定义金额,
-- Σ 已提交(未驳回)≤ 净应付(net_payable)。提交即 emit payable.created 给财务建 payable_records;
-- 财务付完 payment.completed(回带 source_ref=本表 id)→ 节拍器累加对账 paid_amount。
-- 付款执行/审批/排款仍归财务;本表只是采购发起的分批申请。纯加法。⚠️ 人工在 Supabase 执行。
-- ========================================================================

CREATE TABLE IF NOT EXISTS public.procurement_payment_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no          text UNIQUE,          -- PR-YYYYMMDD-NNN(app 生成;= 财务 bill_no 防重付)
  reconciliation_id   uuid NOT NULL REFERENCES public.procurement_reconciliations(id) ON DELETE CASCADE,
  purchase_order_id   uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  supplier_id         uuid,
  supplier_name       text,
  amount              numeric(14,2) NOT NULL,   -- 本笔自定义申请金额
  currency            text DEFAULT 'RMB',
  week_label          text,                     -- 周次/备注(如「2026-W28」)
  note                text,
  status              text NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('draft','submitted','approved','paid','rejected','cancelled')),
  finance_payable_ref text,                     -- 财务回执(payable_records id/bill_no)
  submitted_by        uuid,
  submitted_at        timestamptz DEFAULT now(),
  paid_amount         numeric(14,2) DEFAULT 0,  -- payment.completed 回传累加
  paid_at             timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ppr_recon ON public.procurement_payment_requests(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_ppr_po ON public.procurement_payment_requests(purchase_order_id);

-- RLS:采购/采购经理/管理员读写;财务/管理员只读(与对账表同口径)
ALTER TABLE public.procurement_payment_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ppr_rw ON public.procurement_payment_requests;
CREATE POLICY ppr_rw ON public.procurement_payment_requests FOR ALL USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
    AND (p.role IN ('admin','finance','procurement','procurement_manager','admin_assistant')
         OR p.roles && ARRAY['admin','finance','procurement','procurement_manager','admin_assistant']::text[]))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
    AND (p.role IN ('admin','procurement','procurement_manager')
         OR p.roles && ARRAY['admin','procurement','procurement_manager']::text[]))
);

-- ========================================================================
-- 验证(期望 1 行表 + 1 行策略):
--   SELECT table_name FROM information_schema.tables WHERE table_name='procurement_payment_requests';
--   SELECT policyname FROM pg_policies WHERE tablename='procurement_payment_requests';
-- 回滚:DROP TABLE public.procurement_payment_requests CASCADE;
-- ========================================================================
