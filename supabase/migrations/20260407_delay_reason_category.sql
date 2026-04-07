-- ===== 2026-04-07 延期申请原因分类 =====

-- 增加原因分类字段（客户/供应商/内部/不可抗力）
ALTER TABLE public.delay_requests
  ADD COLUMN IF NOT EXISTS reason_category text CHECK (
    reason_category IN ('customer', 'supplier', 'internal', 'force_majeure')
  );

-- 增加延期天数字段（审批时记录实际批准的天数）
ALTER TABLE public.delay_requests
  ADD COLUMN IF NOT EXISTS delay_days integer;

-- 是否影响最终交期
ALTER TABLE public.delay_requests
  ADD COLUMN IF NOT EXISTS impacts_final_delivery boolean DEFAULT false;

COMMENT ON COLUMN public.delay_requests.reason_category IS
  '延期原因分类：customer=客户原因(顺延交期), supplier=供应商原因, internal=内部原因(压缩下游), force_majeure=不可抗力';
