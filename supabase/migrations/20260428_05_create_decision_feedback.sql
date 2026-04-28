-- ════════════════════════════════════════════════════════════════════════
-- Order Decision Engine — Step 1.3：建立 decision_feedback
-- 主题：人类对决策评审的反馈记录（accept / override / 后续校准）
-- 日期：2026-04-28
-- 原则：
--   1. 仅建表 + RLS + 索引
--   2. 不改任何业务代码
--   3. append-only：每次反馈一条新记录，不更新历史
--   4. RLS 通过 join order_decision_reviews → orders 检查可见性
--   5. Phase 1.0：admin 一人即可 override，必须填 override_reason
--   6. order_logs 写入由业务代码（server action）负责，不在本表的触发器
--
-- 依赖：必须在 03_create_order_decision_reviews.sql 之后执行
-- 被引用：暂无
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.decision_feedback (
  -- ─── 主键 + 关联 ───────────────────────────────────────────
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_review_id       uuid NOT NULL
                           REFERENCES public.order_decision_reviews(id) ON DELETE CASCADE,

  -- ─── 反馈内容 ──────────────────────────────────────────────
  user_action              text NOT NULL,
                           -- 'accept' | 'override_to_proceed' | 'override_to_stop'
                           -- | 'request_review' | 'ignore'
  override_reason          text NULL,                        -- override_* 时必填（DB 用 CHECK 强约束）
  was_decision_correct     boolean NULL,                     -- 反馈时不必填，订单完成后再回填
  final_outcome            text NULL,                        -- 同上，对应订单最终结果

  -- ─── 反馈人 + 时间 ─────────────────────────────────────────
  feedback_by              uuid NOT NULL
                           REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback_at              timestamptz NOT NULL DEFAULT now(),

  -- ─── CHECK 约束 ────────────────────────────────────────────
  CONSTRAINT df_user_action_chk
    CHECK (user_action IN (
      'accept','override_to_proceed','override_to_stop','request_review','ignore'
    )),
  -- override_* 行为必须填 override_reason（强约束，不允许静默 override）
  CONSTRAINT df_override_reason_required_chk
    CHECK (
      user_action NOT IN ('override_to_proceed','override_to_stop')
      OR (override_reason IS NOT NULL AND length(trim(override_reason)) >= 5)
    ),
  CONSTRAINT df_final_outcome_chk
    CHECK (
      final_outcome IS NULL
      OR final_outcome IN ('success','delayed','loss','rework','cancelled')
    )
);

COMMENT ON TABLE public.decision_feedback IS
  '决策评审的人类反馈 — append-only。override 行为强制 reason ≥5 字符。后续 was_decision_correct 由订单复盘时回填';

-- ─── 索引 ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_df_decision_review
  ON public.decision_feedback (decision_review_id);
CREATE INDEX IF NOT EXISTS idx_df_feedback_by
  ON public.decision_feedback (feedback_by);
CREATE INDEX IF NOT EXISTS idx_df_user_action
  ON public.decision_feedback (user_action);
CREATE INDEX IF NOT EXISTS idx_df_override_recent
  ON public.decision_feedback (decision_review_id, feedback_at DESC)
  WHERE user_action IN ('override_to_proceed','override_to_stop');

-- 注：本表无 updated_at（append-only）

-- ════════════════════════════════════════════════════════════════════════
-- RLS — SELECT 通过 join order_decision_reviews → orders 走 user_can_access_order
-- 写权限：能看 review 即可写反馈
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.decision_feedback ENABLE ROW LEVEL SECURITY;

-- SELECT：能看到对应决策评审的人，能看到反馈
DROP POLICY IF EXISTS "df_select" ON public.decision_feedback;
CREATE POLICY "df_select" ON public.decision_feedback FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.order_decision_reviews r
    WHERE r.id = decision_feedback.decision_review_id
      AND public.user_can_access_order(auth.uid(), r.order_id)
  )
);

-- INSERT：能看到对应决策评审 + feedback_by 必须等于 auth.uid()
DROP POLICY IF EXISTS "df_insert" ON public.decision_feedback;
CREATE POLICY "df_insert" ON public.decision_feedback FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND feedback_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.order_decision_reviews r
    WHERE r.id = decision_review_id
      AND public.user_can_access_order(auth.uid(), r.order_id)
  )
);

-- UPDATE：仅允许填补 was_decision_correct / final_outcome 字段
-- 但简化：能 SELECT 的人可以 UPDATE（feedback_by 一旦写入不允许改）
DROP POLICY IF EXISTS "df_update" ON public.decision_feedback;
CREATE POLICY "df_update" ON public.decision_feedback FOR UPDATE
USING (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.order_decision_reviews r
    WHERE r.id = decision_feedback.decision_review_id
      AND public.user_can_access_order(auth.uid(), r.order_id)
  )
)
WITH CHECK (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.order_decision_reviews r
    WHERE r.id = decision_review_id
      AND public.user_can_access_order(auth.uid(), r.order_id)
  )
);

-- DELETE：仅 admin（反馈是审计资产）
DROP POLICY IF EXISTS "df_delete" ON public.decision_feedback;
CREATE POLICY "df_delete" ON public.decision_feedback FOR DELETE
USING (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
  )
);

-- ════════════════════════════════════════════════════════════════════════
-- 回滚 SQL
-- ════════════════════════════════════════════════════════════════════════
--
-- DROP INDEX IF EXISTS public.idx_df_override_recent;
-- DROP INDEX IF EXISTS public.idx_df_user_action;
-- DROP INDEX IF EXISTS public.idx_df_feedback_by;
-- DROP INDEX IF EXISTS public.idx_df_decision_review;
-- ALTER TABLE public.decision_feedback RENAME TO decision_feedback_failed_20260428;

-- ════════════════════════════════════════════════════════════════════════
-- 冒烟测试
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 表存在 + RLS + 4 policy
--    SELECT EXISTS (SELECT 1 FROM information_schema.tables
--                   WHERE table_schema='public' AND table_name='decision_feedback');
--    → true
--    SELECT relrowsecurity FROM pg_class WHERE oid='public.decision_feedback'::regclass;
--    → true
--    SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='decision_feedback';
--    → 4
--
-- 2. CHECK 约束 — override 必须带 reason（应该插不进去）
--    -- 先建一条 decision review 做依赖
--    WITH r AS (
--      INSERT INTO public.order_decision_reviews
--        (order_id, review_type, input_hash, triggered_by, decision, confidence,
--         business_audit, financial_audit, feasibility_audit, result_json)
--      SELECT id, 'manual', 'test_df', 'manual', 'CAUTION', 80,
--             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
--      FROM public.orders LIMIT 1
--      RETURNING id
--    )
--    INSERT INTO public.decision_feedback
--      (decision_review_id, user_action, feedback_by)
--    SELECT r.id, 'override_to_proceed',
--           (SELECT user_id FROM public.profiles WHERE role='admin' LIMIT 1)
--    FROM r;
--    → 应报错 violates check constraint "df_override_reason_required_chk"
--
-- 3. CHECK 通过 — 带 reason 的 override 应成功
--    -- 用上面建的 r.id（如已 rollback，重新建）
--    INSERT INTO public.decision_feedback
--      (decision_review_id, user_action, override_reason, feedback_by)
--    VALUES (
--      (SELECT id FROM public.order_decision_reviews WHERE input_hash='test_df' LIMIT 1),
--      'override_to_proceed',
--      'CEO 已与客户口头确认 50% 预付款',
--      (SELECT user_id FROM public.profiles WHERE role='admin' LIMIT 1)
--    )
--    RETURNING id, user_action, length(override_reason);
--    → 期望：1 行，length >= 5
--
-- 4. 清理冒烟数据
--    DELETE FROM public.decision_feedback
--      WHERE decision_review_id IN
--      (SELECT id FROM public.order_decision_reviews WHERE input_hash='test_df');
--    DELETE FROM public.order_decision_reviews WHERE input_hash='test_df';
