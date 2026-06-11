-- ===== 20260611 Customer Matters（CEO 客户事项分级，Phase 1）=====
-- 零 AI 纯规则物化：疑似投诉/质量邮件（mail_inbox 关键词 × customer_email_domains 归类）
-- + 交期/订单风险（runtime_orders 置信度 + 关键节点逾期）。
-- Phase 1 仅 dry-run/execute 手动接口（/api/admin/customer-matters-materialize），不接 nightly cron。
-- 本文件幂等，可安全重复执行。

CREATE TABLE IF NOT EXISTS public.customer_matters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name   text NOT NULL,
  order_id        uuid REFERENCES public.orders(id) ON DELETE CASCADE,  -- 投诉类多为客户级，可空
  order_no        text,
  matter_type     text NOT NULL CHECK (matter_type IN ('suspected_complaint','delivery_risk','overdue')),
  severity        text NOT NULL CHECK (severity IN ('high','medium')),
  title           text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source          text NOT NULL CHECK (source IN ('email','order')),
  source_ref      text NOT NULL,                  -- email:<mail_inbox.id> / order:<order_id>:<step_key|confidence>
  matter_key      text NOT NULL,                  -- 确定性键：去重 + 重建锚点
  detected_at     timestamptz NOT NULL,           -- 信号源时间（邮件 received_at / 节点 due_at 等）
  materialized_at timestamptz NOT NULL DEFAULT now(),  -- 本轮物化时间；重建后未刷新的行 = 已解决，被清理
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_matters_matter_key_idx
  ON public.customer_matters(matter_key);
CREATE INDEX IF NOT EXISTS customer_matters_customer_idx
  ON public.customer_matters(customer_name, severity);

ALTER TABLE public.customer_matters ENABLE ROW LEVEL SECURITY;

-- 照搬 customer_rhythm 口径：service-role 写（无 authenticated 写策略），登录可读
DROP POLICY IF EXISTS "cm_select_auth" ON public.customer_matters;
CREATE POLICY "cm_select_auth" ON public.customer_matters
  FOR SELECT USING (auth.uid() IS NOT NULL);
