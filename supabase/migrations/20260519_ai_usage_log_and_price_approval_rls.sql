-- ===== 2026-05-19 AI 配额日志 + price_approval RLS 收紧 =====
--
-- 目的：
--  A. 给 AI 调用做配额追踪 + 限速（防 Anthropic API 配额被刷）
--  B. 收紧 pre_order_price_approvals 的 RLS — 之前 USING(true) 等于全员可改

-- ──────────────────────────────────────────────
-- A. ai_usage_log — AI 调用审计表
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  api text NOT NULL,
  -- api 枚举（用 text 不用 enum 方便后续扩展）：
  --   'po_parse'         客户 PO 解析
  --   'po_verify'        PO 二次核对
  --   'three_doc_verify' 三单比对
  --   'photo_ocr'        生产 QC 拍照识别
  --   'cost_sheet'       成本核算单解析
  --   'production_photo' 生产日报照片提取
  --   'risk_assessment'  AI 风险评估
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  -- 业务上下文（成功 / 失败 / 超时 / 限速拒绝）
  status text NOT NULL CHECK (status IN ('success','error','rate_limited','timeout')),
  duration_ms int,
  -- 用于配额追踪：估算 token / cost（可选，0 表示未计算）
  cost_cents int DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_user_created
  ON public.ai_usage_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_api_created
  ON public.ai_usage_log(api, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_order
  ON public.ai_usage_log(order_id) WHERE order_id IS NOT NULL;

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;

-- 普通用户：只能看自己的调用记录
DROP POLICY IF EXISTS "ai_usage_log_select_own" ON public.ai_usage_log;
CREATE POLICY "ai_usage_log_select_own" ON public.ai_usage_log
  FOR SELECT
  USING (user_id = auth.uid());

-- admin / finance：看全部（成本追踪 / 滥用排查）
DROP POLICY IF EXISTS "ai_usage_log_select_admin" ON public.ai_usage_log;
CREATE POLICY "ai_usage_log_select_admin" ON public.ai_usage_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','finance')
          OR 'admin' = ANY(COALESCE(p.roles, ARRAY[]::text[]))
          OR 'finance' = ANY(COALESCE(p.roles, ARRAY[]::text[]))
        )
    )
  );

-- INSERT：服务端用 user-session 写自己的记录（user_id = auth.uid()）
DROP POLICY IF EXISTS "ai_usage_log_insert_self" ON public.ai_usage_log;
CREATE POLICY "ai_usage_log_insert_self" ON public.ai_usage_log
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- UPDATE / DELETE：禁用（审计表不可改）
-- 没有任何 UPDATE/DELETE policy = 默认拒绝

COMMENT ON TABLE public.ai_usage_log IS
  '所有 AI（Anthropic）调用的审计 + 配额追踪表。append-only，不允许 UPDATE/DELETE。';

-- ──────────────────────────────────────────────
-- B. pre_order_price_approvals RLS 收紧
-- ──────────────────────────────────────────────
-- 之前的 policy: USING (auth.uid() IS NOT NULL)
-- 问题：任何登录用户能 SELECT/INSERT/UPDATE/DELETE 全部审批记录
--   - 销售员可读他人客户的报价（敏感商业信息）
--   - 销售员可篡改 status 伪造「已通过」绕过 CEO
--   - 任何人可 DELETE 销毁审批记录（破坏审计）

DROP POLICY IF EXISTS "pre_order_price_approvals_authenticated"
  ON public.pre_order_price_approvals;

-- SELECT：自己提的 OR admin / finance
DROP POLICY IF EXISTS "pre_order_price_approvals_select"
  ON public.pre_order_price_approvals;
CREATE POLICY "pre_order_price_approvals_select"
  ON public.pre_order_price_approvals
  FOR SELECT
  USING (
    requested_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','finance')
          OR 'admin' = ANY(COALESCE(p.roles, ARRAY[]::text[]))
          OR 'finance' = ANY(COALESCE(p.roles, ARRAY[]::text[]))
        )
    )
  );

-- INSERT：任何登录用户都可提申请（业务流程的起点）
DROP POLICY IF EXISTS "pre_order_price_approvals_insert"
  ON public.pre_order_price_approvals;
CREATE POLICY "pre_order_price_approvals_insert"
  ON public.pre_order_price_approvals
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND requested_by = auth.uid()  -- 不能伪造他人发起
  );

-- UPDATE：仅 admin（CEO 审批）
DROP POLICY IF EXISTS "pre_order_price_approvals_update"
  ON public.pre_order_price_approvals;
CREATE POLICY "pre_order_price_approvals_update"
  ON public.pre_order_price_approvals
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role = 'admin'
          OR 'admin' = ANY(COALESCE(p.roles, ARRAY[]::text[]))
        )
    )
  );

-- DELETE：禁用（审计表，永远保留）
-- 不创建 DELETE policy = 默认拒绝

COMMENT ON TABLE public.pre_order_price_approvals IS
  '订单创建前的价格审批（CEO 强制规则）。RLS：自己提的可读，admin/finance 全读，仅 admin 可改，永不允许删。';
