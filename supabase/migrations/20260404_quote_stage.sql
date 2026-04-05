-- ===== 2026-04-04 报价流程完善 — quote_stage 状态机 =====

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS quote_stage text DEFAULT 'draft'
  CHECK (quote_stage IN (
    'draft', 'pending_review', 'approved', 'sent_to_customer',
    'customer_accepted', 'customer_revision', 'customer_rejected',
    'sample_created', 'order_created'
  ));

-- 已有报价的数据迁移
UPDATE public.orders SET quote_stage = 'approved' WHERE quote_status = 'approved' AND quote_stage IS NULL;
UPDATE public.orders SET quote_stage = 'pending_review' WHERE quote_status = 'pending' AND quote_stage IS NULL;
UPDATE public.orders SET quote_stage = 'customer_rejected' WHERE quote_status = 'rejected' AND quote_stage IS NULL;
