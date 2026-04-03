-- ===== 2026-04-02 修复 delay_requests 表 + 新增 delivery_type =====

-- ══════════════════════════════════════════════════════════════
-- 1. 修复 delay_requests 表：新增代码中需要的列
--    原始 migration.sql 只有 (requested_days, reason)
--    代码需要 (reason_type, reason_detail, proposed_new_anchor_date, ...)
-- ══════════════════════════════════════════════════════════════

-- 1a. 添加 order_id（代码中 insert 需要）
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE;

-- 1b. 添加延期申请的详细字段
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS reason_type text;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS reason_detail text;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS proposed_new_anchor_date date;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS proposed_new_due_at timestamptz;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS requires_customer_approval boolean NOT NULL DEFAULT false;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS customer_approval_evidence_url text;
ALTER TABLE public.delay_requests ADD COLUMN IF NOT EXISTS decision_note text;

-- 1c. 旧字段变为可选（旧的 requested_days / reason 不再被代码使用）
ALTER TABLE public.delay_requests ALTER COLUMN requested_days DROP NOT NULL;
ALTER TABLE public.delay_requests ALTER COLUMN reason DROP NOT NULL;

-- 1d. status 列可能是 enum 类型，确保兼容 text 值
-- 先检查：如果 status 是 delay_request_status enum，改为 text
DO $$
BEGIN
  -- 只在 status 列是 enum 类型时才转换
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'delay_requests'
      AND column_name = 'status'
      AND udt_name = 'delay_request_status'
  ) THEN
    ALTER TABLE public.delay_requests
      ALTER COLUMN status TYPE text USING status::text;
  END IF;
END $$;

-- 1e. 为 order_id 建索引（加速查询）
CREATE INDEX IF NOT EXISTS idx_delay_requests_order_id ON public.delay_requests(order_id);

-- 1f. 回填 order_id（从 milestone 表获取）
UPDATE public.delay_requests dr
SET order_id = m.order_id
FROM public.milestones m
WHERE dr.milestone_id = m.id
  AND dr.order_id IS NULL;

-- ══════════════════════════════════════════════════════════════
-- 2. orders 表新增 delivery_type：区分出口/国内送仓
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_type text NOT NULL DEFAULT 'export'
  CHECK (delivery_type IN ('export', 'domestic'));

-- 自动回填：人民币订单默认为国内送仓
UPDATE public.orders
SET delivery_type = 'domestic'
WHERE incoterm IN ('RMB_EX_TAX', 'RMB_INC_TAX')
  AND delivery_type = 'export';
