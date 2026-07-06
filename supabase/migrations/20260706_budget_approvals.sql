-- ============================================================
-- 20260706_budget_approvals —— 超预算提交采购 两级审批
-- 口径(用户 2026-07-06 拍板):BOM 单耗只要超报价基线 → 拦,报业务执行经理批;
--   超过 5% → 业务经理 + 财务 都要批。批过才能提交采购。
-- 写入全走 service-role(应用层 action 已做 auth+角色门禁);表启 RLS 无策略=挡用户会话直连。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.procurement_budget_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  requested_by   uuid,
  requested_at   timestamptz DEFAULT now(),
  over_lines     jsonb DEFAULT '[]'::jsonb,   -- [{material, bom_cons, base_cons, over_pct}]
  max_over_pct   numeric DEFAULT 0,           -- 本次最大超标百分比
  needs_finance  boolean DEFAULT false,       -- 是否需要财务批(max_over_pct > 5)
  mgr_status     text DEFAULT 'pending',      -- 业务执行经理:pending/approved/rejected
  mgr_by         uuid, mgr_at timestamptz, mgr_note text,
  fin_status     text DEFAULT 'not_required', -- 财务:not_required/pending/approved/rejected
  fin_by         uuid, fin_at timestamptz, fin_note text,
  status         text DEFAULT 'pending',      -- 总体:pending/approved/rejected
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pba_order   ON public.procurement_budget_approvals(order_id);
CREATE INDEX IF NOT EXISTS idx_pba_status  ON public.procurement_budget_approvals(status);

ALTER TABLE public.procurement_budget_approvals ENABLE ROW LEVEL SECURITY;
-- 无策略:用户会话直连读写被挡;全部经 service-role 的 server action(action 内已做角色门禁)。

COMMENT ON TABLE public.procurement_budget_approvals IS
  '超预算提交采购两级审批:超基线单耗→业务经理批;超5%→+财务批。批过才放行提交采购。';

-- ── 验证(手动)──
-- SELECT to_regclass('public.procurement_budget_approvals');  → 非空
-- SELECT relrowsecurity FROM pg_class WHERE relname='procurement_budget_approvals';  → true
