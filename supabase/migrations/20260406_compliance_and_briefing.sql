-- ===== 2026-04-06 邮件-订单执行对照 + 业务员每日简报 =====

-- 1. 执行对照发现
CREATE TABLE IF NOT EXISTS public.compliance_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_type text NOT NULL CHECK (finding_type IN (
    'po_confirmed_no_order',
    'quantity_mismatch_stale',
    'delivery_date_not_updated',
    'complaint_not_addressed',
    'sample_feedback_not_updated',
    'urgent_unanswered',
    'requirements_not_documented',
    'modification_not_applied'
  )),
  mail_inbox_id uuid REFERENCES public.mail_inbox(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_name text,
  salesperson_user_id uuid REFERENCES auth.users(id),
  title text NOT NULL,
  description text,
  severity text DEFAULT 'medium' CHECK (severity IN ('high', 'medium', 'low')),
  email_date timestamptz,
  days_since_email integer,
  status text DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  resolution_note text,
  agent_action_id uuid REFERENCES public.agent_actions(id) ON DELETE SET NULL,
  dedup_key text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_findings_status ON public.compliance_findings(status);
CREATE INDEX IF NOT EXISTS idx_compliance_findings_salesperson ON public.compliance_findings(salesperson_user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_findings_dedup ON public.compliance_findings(dedup_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_compliance_findings_type ON public.compliance_findings(finding_type);

ALTER TABLE public.compliance_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "compliance_findings_authenticated" ON public.compliance_findings
  FOR ALL USING (auth.uid() IS NOT NULL);

-- 2. 每日简报
CREATE TABLE IF NOT EXISTS public.daily_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  briefing_date date NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  summary_text text,
  total_emails integer DEFAULT 0,
  urgent_count integer DEFAULT 0,
  compliance_count integer DEFAULT 0,
  wechat_sent boolean DEFAULT false,
  email_sent boolean DEFAULT false,
  notification_sent boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, briefing_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_briefings_user_date ON public.daily_briefings(user_id, briefing_date DESC);

ALTER TABLE public.daily_briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_briefings_own_select" ON public.daily_briefings
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "daily_briefings_insert" ON public.daily_briefings
  FOR INSERT WITH CHECK (true);
