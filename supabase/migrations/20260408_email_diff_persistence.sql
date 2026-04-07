-- ===== 2026-04-08 邮件 AI 加强 — 差异持久化 + 无声失败监控 =====

-- 1. 邮件处理状态：用于发现"无声失败"（被吞掉的邮件）
ALTER TABLE public.mail_inbox
  ADD COLUMN IF NOT EXISTS processing_status text DEFAULT 'pending'
    CHECK (processing_status IN (
      'pending',           -- 入库待处理
      'fully_matched',     -- 客户+订单都匹配成功
      'matched_customer',  -- 只匹配到客户，没匹配到订单
      'unmatched',         -- 客户和订单都没匹配
      'parse_failed',      -- AI 解析失败
      'skipped'            -- 显式跳过（如重复邮件）
    ));

ALTER TABLE public.mail_inbox
  ADD COLUMN IF NOT EXISTS last_processed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_mail_inbox_processing_status
  ON public.mail_inbox(processing_status, received_at DESC)
  WHERE processing_status IN ('unmatched', 'matched_customer', 'parse_failed');

-- 2. 邮件-订单差异持久化表
-- 之前差异检测结果只在通知里，无法追溯"差异是否解决"
CREATE TABLE IF NOT EXISTS public.email_order_diffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mail_inbox_id uuid REFERENCES public.mail_inbox(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  -- 差异内容（来自 deepCompareEmailWithOrder 的结果）
  field text NOT NULL,           -- 数量/交期/颜色/要求/状态/变更
  email_value text,
  order_value text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('high', 'medium', 'low')),
  suggestion text,
  -- 状态追溯
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored', 'false_positive')),
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  resolution_note text,
  -- 元数据
  detected_at timestamptz DEFAULT now(),
  -- 去重：同一封邮件 + 同一订单 + 同一字段，只存一次
  dedup_key text GENERATED ALWAYS AS (mail_inbox_id::text || '|' || order_id::text || '|' || field) STORED,
  UNIQUE(dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_email_order_diffs_order ON public.email_order_diffs(order_id, status);
CREATE INDEX IF NOT EXISTS idx_email_order_diffs_status ON public.email_order_diffs(status, severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_order_diffs_mail ON public.email_order_diffs(mail_inbox_id);

ALTER TABLE public.email_order_diffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_order_diffs_authenticated" ON public.email_order_diffs
  FOR ALL USING (auth.uid() IS NOT NULL);

COMMENT ON COLUMN public.mail_inbox.processing_status IS '邮件处理状态，用于发现"被吞掉"的邮件（unmatched / matched_customer）';
COMMENT ON TABLE public.email_order_diffs IS '邮件-订单差异检测结果持久化，可追溯"差异是否解决"';
