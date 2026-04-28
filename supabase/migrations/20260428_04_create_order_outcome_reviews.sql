-- ════════════════════════════════════════════════════════════════════════
-- Order Decision Engine — Step 1.2：建立 order_outcome_reviews
-- 主题：订单结束后的复盘记录，作为决策准确度反馈的"事实层"
-- 日期：2026-04-28
-- 原则：
--   1. 仅建表 + RLS + 索引
--   2. 不改任何业务代码
--   3. 不批量回填历史订单
--   4. 一对一：每个订单最多一条复盘记录（UNIQUE order_id）
--   5. 关联回首次决策（initial_decision_id）用于事后校准
--   6. Phase 1.0 仅建表，UI 表单留 Phase 1.2
--
-- 依赖：必须在 03_create_order_decision_reviews.sql 之后执行
-- 被引用：暂无
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_outcome_reviews (
  -- ─── 主键 + 关联 ───────────────────────────────────────────
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid NOT NULL UNIQUE
                           REFERENCES public.orders(id) ON DELETE CASCADE,

  -- ─── 实际结果 ──────────────────────────────────────────────
  final_result             text NOT NULL,
                           -- 'success' | 'delayed' | 'loss' | 'rework' | 'cancelled'
  delay_days               integer NULL,                     -- 实际延期天数（负数 = 提前）
  actual_margin_pct        numeric NULL,                     -- 实际毛利率
  has_rework               boolean NOT NULL DEFAULT false,
  has_complaint            boolean NOT NULL DEFAULT false,

  -- ─── 原因结构化 ────────────────────────────────────────────
  root_cause_codes         text[] NULL,                      -- 引用 order_root_causes.cause_code
  responsible_stage        text NULL,                        -- 责任环节

  -- ─── 资产沉淀（自由文本）──────────────────────────────────
  resolution_actions       text NULL,
  lessons_learned          text NULL,

  -- ─── 关联回当时的决策（事后校准用）────────────────────────
  initial_decision_id      uuid NULL
                           REFERENCES public.order_decision_reviews(id) ON DELETE SET NULL,
  decision_was_correct     boolean NULL,                     -- 复盘人填：当时决策回头看对不对

  -- ─── 复盘人 + 时间 ─────────────────────────────────────────
  reviewed_by              uuid NULL
                           REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at              timestamptz NOT NULL DEFAULT now(),

  -- ─── CHECK 约束 ────────────────────────────────────────────
  CONSTRAINT oor_final_result_chk
    CHECK (final_result IN ('success','delayed','loss','rework','cancelled')),
  CONSTRAINT oor_responsible_stage_chk
    CHECK (
      responsible_stage IS NULL OR responsible_stage IN (
        'sales','finance','merchandiser','procurement','production',
        'qc','logistics','customer','factory','supplier','admin'
      )
    ),
  CONSTRAINT oor_actual_margin_chk
    CHECK (actual_margin_pct IS NULL OR actual_margin_pct BETWEEN -100 AND 100)
);

COMMENT ON TABLE public.order_outcome_reviews IS
  '订单结束复盘 — 一对一，记录订单实际表现 + 关联回当时的决策评审，是决策准确度校准的事实层';

-- ─── 索引 ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_oor_final_result
  ON public.order_outcome_reviews (final_result);
CREATE INDEX IF NOT EXISTS idx_oor_initial_decision
  ON public.order_outcome_reviews (initial_decision_id)
  WHERE initial_decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oor_responsible_stage
  ON public.order_outcome_reviews (responsible_stage)
  WHERE responsible_stage IS NOT NULL;

-- 注：本表无 updated_at（append-mostly；如需修改建议删除后重建）

-- ════════════════════════════════════════════════════════════════════════
-- RLS — SELECT 走 user_can_access_order；写权限给 admin / sales / 订单 owner
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.order_outcome_reviews ENABLE ROW LEVEL SECURITY;

-- SELECT
DROP POLICY IF EXISTS "oor_select" ON public.order_outcome_reviews;
CREATE POLICY "oor_select" ON public.order_outcome_reviews FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
);

-- INSERT：admin / sales / 订单创建者 / 订单负责人
DROP POLICY IF EXISTS "oor_insert" ON public.order_outcome_reviews;
CREATE POLICY "oor_insert" ON public.order_outcome_reviews FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','sales')
          OR (p.roles && ARRAY['admin','sales']::text[])
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- UPDATE：同 INSERT
DROP POLICY IF EXISTS "oor_update" ON public.order_outcome_reviews;
CREATE POLICY "oor_update" ON public.order_outcome_reviews FOR UPDATE
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
)
WITH CHECK (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (
          p.role IN ('admin','sales')
          OR (p.roles && ARRAY['admin','sales']::text[])
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- DELETE：仅 admin
DROP POLICY IF EXISTS "oor_delete" ON public.order_outcome_reviews;
CREATE POLICY "oor_delete" ON public.order_outcome_reviews FOR DELETE
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
-- DROP INDEX IF EXISTS public.idx_oor_responsible_stage;
-- DROP INDEX IF EXISTS public.idx_oor_initial_decision;
-- DROP INDEX IF EXISTS public.idx_oor_final_result;
-- ALTER TABLE public.order_outcome_reviews RENAME TO order_outcome_reviews_failed_20260428;

-- ════════════════════════════════════════════════════════════════════════
-- 冒烟测试
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 表存在性
--    SELECT EXISTS (SELECT 1 FROM information_schema.tables
--                   WHERE table_schema='public' AND table_name='order_outcome_reviews');
--    → true
--
-- 2. UNIQUE(order_id) 生效
--    SELECT conname, contype FROM pg_constraint
--    WHERE conrelid = 'public.order_outcome_reviews'::regclass AND contype='u';
--    → 应有一条 UNIQUE 约束
--
-- 3. RLS + Policy
--    SELECT relrowsecurity FROM pg_class WHERE oid='public.order_outcome_reviews'::regclass;
--    → true
--    SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='order_outcome_reviews';
--    → 4
--
-- 4. CHECK 约束（应该插不进去）
--    INSERT INTO public.order_outcome_reviews (order_id, final_result)
--    SELECT id, 'INVALID_RESULT' FROM public.orders LIMIT 1;
--    → 应报错 violates check constraint "oor_final_result_chk"
--
-- 5. 合法 INSERT（service_role / SQL Editor）
--    INSERT INTO public.order_outcome_reviews
--      (order_id, final_result, delay_days, actual_margin_pct, responsible_stage)
--    SELECT id, 'success', 0, 12.5, 'sales' FROM public.orders LIMIT 1
--    RETURNING id, final_result, delay_days, has_rework, reviewed_at;
--    → 期望：1 行，has_rework=false（默认值），reviewed_at=now()
--
--    -- 验证完立即删：
--    DELETE FROM public.order_outcome_reviews WHERE final_result='success' AND delay_days=0;
