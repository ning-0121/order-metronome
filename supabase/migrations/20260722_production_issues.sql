-- ============================================================
-- 2026-07-22 生产今日工作台 · 第3步:生产问题记录表 production_issues
-- 跟单在跟进中随手记问题(料没到/工厂拖/质量异常/包装错…),可设定时提醒;
-- 到点由 cron/reminders 提醒负责人(站内+企微);未解决的进「追踪历史问题」今日待办。
-- 写入走 user session(受 RLS),角色在 action 层用 requireRoleGroup('EXECUTION') 把关。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.production_issues (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  milestone_id uuid REFERENCES public.milestones(id) ON DELETE SET NULL,
  category text,                       -- material/factory/quality/packing/delivery/other
  title text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,  -- 负责跟进/被提醒人
  remind_at timestamptz,               -- 定时提醒时间(到点提醒 assigned_to)
  last_reminded_at timestamptz,        -- 上次提醒时间(防重复推送)
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  resolution_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_issues_order ON public.production_issues(order_id);
CREATE INDEX IF NOT EXISTS idx_production_issues_assignee ON public.production_issues(assigned_to, status);
-- 到点提醒扫描:只扫未解决 + 有提醒时间的
CREATE INDEX IF NOT EXISTS idx_production_issues_remind ON public.production_issues(remind_at)
  WHERE status = 'open' AND remind_at IS NOT NULL;

ALTER TABLE public.production_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prod_issue_select_auth" ON public.production_issues FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "prod_issue_insert_auth" ON public.production_issues FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "prod_issue_update_auth" ON public.production_issues FOR UPDATE USING (auth.uid() IS NOT NULL);
