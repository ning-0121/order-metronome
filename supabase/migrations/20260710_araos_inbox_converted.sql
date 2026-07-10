-- araos_handoffs_inbox: 记录该 araos PO 已被建成哪张订单（避免重复建单 / 待建单列表过滤）。
-- status 追加取值 'converted'（列为自由文本，无 CHECK，直接可用）。Idempotent.
ALTER TABLE public.araos_handoffs_inbox
  ADD COLUMN IF NOT EXISTS converted_order_id uuid;
