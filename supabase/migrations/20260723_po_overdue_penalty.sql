-- ============================================================
-- 2026-07-23 PO 逾期上传罚款(一期:检测+罚款标记+上报)
-- 规则:客户下达 PO 当日必须建单/上传 PO。逾期(建单日 > 下达日)→ 罚款 ¥200 +
--   绩效扣分 + 上报 业务执行经理(order_manager)/财务(finance)/老板(admin)。
-- 基准"下达日":建单手填 order_date;若 PO 文件解析到 order_date 则以文件为准。
-- 可申请免罚:业务执行经理 + 财务 两方通过免罚;老板(admin)可单方驳回/批准。免罚后撤销罚款+考核。
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS po_overdue boolean NOT NULL DEFAULT false,         -- 上传是否逾期
  ADD COLUMN IF NOT EXISTS po_overdue_days int NOT NULL DEFAULT 0,            -- 逾期天数
  ADD COLUMN IF NOT EXISTS po_penalty_amount numeric NOT NULL DEFAULT 0,      -- 罚款金额(逾期=200)
  ADD COLUMN IF NOT EXISTS po_penalty_waived boolean NOT NULL DEFAULT false,  -- 是否已免罚(审批通过)
  ADD COLUMN IF NOT EXISTS po_baseline_date date;                             -- 逾期判定用的基准下达日(留痕)

-- 免罚申请(二期审批闭环用;一期先建表)
CREATE TABLE IF NOT EXISTS public.po_overdue_waivers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  -- 两方会签 + 老板 override
  order_manager_decision text CHECK (order_manager_decision IN ('approved','rejected')),
  order_manager_by uuid, order_manager_at timestamptz,
  finance_decision text CHECK (finance_decision IN ('approved','rejected')),
  finance_by uuid, finance_at timestamptz,
  admin_override text CHECK (admin_override IN ('approved','rejected')),   -- 老板单方定,优先于两方
  admin_by uuid, admin_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_waivers_order ON public.po_overdue_waivers(order_id);
CREATE INDEX IF NOT EXISTS idx_po_waivers_pending ON public.po_overdue_waivers(status) WHERE status = 'pending';

ALTER TABLE public.po_overdue_waivers ENABLE ROW LEVEL SECURITY;
CREATE POLICY pow_select ON public.po_overdue_waivers FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY pow_insert ON public.po_overdue_waivers FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY pow_update ON public.po_overdue_waivers FOR UPDATE USING (auth.uid() IS NOT NULL);
