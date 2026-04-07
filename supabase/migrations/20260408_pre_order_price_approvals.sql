-- ===== 2026-04-08 订单创建前价格审批 =====
--
-- 业务背景（CEO 拍板）：
-- 新建订单时，AI 必须先校验"内部报价单 vs 客户报价单 vs 客户PO"的价格一致性。
-- 不一致时业务员不能直接创建订单，必须推送 CEO 审批。
-- CEO 审批通过后才能继续创建订单（或要求业务员先和客户对齐 PO）。

CREATE TABLE IF NOT EXISTS public.pre_order_price_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 申请人 + 上下文
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  customer_name text,
  po_number text,
  -- 表单快照（金额/数量/客户/PO号等关键字段）
  form_snapshot jsonb NOT NULL DEFAULT '{}',
  -- AI 检测出的价格差异
  price_diffs jsonb NOT NULL DEFAULT '[]',
  -- AI 总结
  summary text,

  -- 审批状态
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_note text,

  -- 元数据
  created_at timestamptz DEFAULT now(),
  -- 24 小时后自动过期，避免历史审批被复用
  expires_at timestamptz DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_pre_order_price_approvals_status
  ON public.pre_order_price_approvals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pre_order_price_approvals_requester
  ON public.pre_order_price_approvals(requested_by, status);

ALTER TABLE public.pre_order_price_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pre_order_price_approvals_authenticated"
  ON public.pre_order_price_approvals;
CREATE POLICY "pre_order_price_approvals_authenticated"
  ON public.pre_order_price_approvals
  FOR ALL USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.pre_order_price_approvals IS
  '订单创建前的价格审批 — CEO 必须放行三单价格不一致的订单';

-- 订单关联到价格审批 — 用于审计追溯
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS price_approval_id uuid REFERENCES public.pre_order_price_approvals(id);
COMMENT ON COLUMN public.orders.price_approval_id IS
  '若订单创建时三单价格不一致，需要 CEO 审批，此字段记录对应审批 ID';
