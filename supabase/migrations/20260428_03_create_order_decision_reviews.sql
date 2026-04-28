-- ════════════════════════════════════════════════════════════════════════
-- Order Decision Engine — Step 1.1：建立 order_decision_reviews
-- 主题：决策评审主表，记录每次评审的输入指纹、规则结果、AI 痕迹、override 状态
-- 日期：2026-04-28
-- 原则：
--   1. 仅建表 + RLS + 索引 + 触发器
--   2. 不改任何业务代码
--   3. Phase 1.0 不接 AI（ai_used / ai_model_used 等字段保留但默认空）
--   4. 不批量回填
--   5. 仅人工 admin 触发，不接 cron
--   6. 决策不会自动改 workflow，只显示给 admin
--
-- 后续依赖关系：
--   - migration 04 (order_outcome_reviews.initial_decision_id) → 引用本表
--   - migration 05 (decision_feedback.decision_review_id) → 引用本表
-- 所以本文件必须先于 04/05 执行。
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_decision_reviews (
  -- ─── 主键 + 关联 ───────────────────────────────────────────
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid NOT NULL
                           REFERENCES public.orders(id) ON DELETE CASCADE,

  -- ─── 评审元数据 ────────────────────────────────────────────
  review_type              text NOT NULL DEFAULT 'pre_kickoff',
  input_hash               text NOT NULL,                    -- 用于 24h 缓存命中
  triggered_by             text NOT NULL,                    -- 触发源
  triggered_field          text NULL,                        -- 字段变化时记录字段名

  -- ─── 决策结果 ──────────────────────────────────────────────
  decision                 text NOT NULL,                    -- PROCEED / CAUTION / STOP
  confidence               integer NOT NULL,                 -- 0-100
  business_audit           jsonb NOT NULL,                   -- {flags:[...], summary:'...'}
  financial_audit          jsonb NOT NULL,
  feasibility_audit        jsonb NOT NULL,

  -- 完整 DecisionResult 序列化（前端原样消费）
  result_json              jsonb NOT NULL,

  -- ─── 规则痕迹 ──────────────────────────────────────────────
  rule_flags               jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ─── AI 痕迹（Phase 1.0 全部留空）──────────────────────────
  ai_used                  boolean NOT NULL DEFAULT false,
  ai_model_used            text NULL,
  ai_call_count            integer NOT NULL DEFAULT 0,
  input_tokens             integer NULL,
  output_tokens            integer NULL,
  cache_hit_tokens         integer NULL,
  cost_usd                 numeric NULL,
  ai_reasoning_summary     text NULL,

  -- ─── Override 状态 ─────────────────────────────────────────
  override_status          text NULL,                        -- NULL / pending / approved / rejected
  override_by              uuid NULL
                           REFERENCES auth.users(id) ON DELETE SET NULL,
  override_reason          text NULL,
  override_at              timestamptz NULL,

  -- ─── 标准时间戳 ────────────────────────────────────────────
  created_by               uuid NULL
                           REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- ─── CHECK 约束 ────────────────────────────────────────────
  CONSTRAINT odr_decision_chk
    CHECK (decision IN ('PROCEED','CAUTION','STOP')),
  CONSTRAINT odr_confidence_chk
    CHECK (confidence BETWEEN 0 AND 100),
  CONSTRAINT odr_review_type_chk
    CHECK (review_type IN ('pre_kickoff','mid_production','pre_shipment','manual')),
  CONSTRAINT odr_triggered_by_chk
    CHECK (triggered_by IN ('manual','field_change','milestone_event')),
  CONSTRAINT odr_override_status_chk
    CHECK (override_status IS NULL OR override_status IN ('pending','approved','rejected')),
  CONSTRAINT odr_ai_call_count_chk
    CHECK (ai_call_count >= 0),
  CONSTRAINT odr_token_chk
    CHECK (
      (input_tokens IS NULL OR input_tokens >= 0)
      AND (output_tokens IS NULL OR output_tokens >= 0)
      AND (cache_hit_tokens IS NULL OR cache_hit_tokens >= 0)
    ),
  CONSTRAINT odr_cost_chk
    CHECK (cost_usd IS NULL OR cost_usd >= 0)
);

COMMENT ON TABLE public.order_decision_reviews IS
  '订单决策评审主表 — 每次 admin 触发评审产生一条记录。Phase 1.0 仅规则路径，AI 字段保留';

-- ─── 索引 ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_odr_order_created
  ON public.order_decision_reviews (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_odr_input_hash
  ON public.order_decision_reviews (input_hash);
CREATE INDEX IF NOT EXISTS idx_odr_decision_alert
  ON public.order_decision_reviews (decision)
  WHERE decision IN ('CAUTION','STOP');
CREATE INDEX IF NOT EXISTS idx_odr_override_pending
  ON public.order_decision_reviews (override_status)
  WHERE override_status = 'pending';

-- ─── updated_at 自动维护触发器 ────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_order_decision_reviews_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_decision_reviews_set_updated_at ON public.order_decision_reviews;
CREATE TRIGGER order_decision_reviews_set_updated_at
  BEFORE UPDATE ON public.order_decision_reviews
  FOR EACH ROW EXECUTE FUNCTION public.tg_order_decision_reviews_set_updated_at();

-- ════════════════════════════════════════════════════════════════════════
-- RLS — 严格按"统一走 user_can_access_order"
-- 写权限叠加 admin / 订单创建者 / 订单负责人
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.order_decision_reviews ENABLE ROW LEVEL SECURITY;

-- SELECT：能看订单 → 能看决策记录
DROP POLICY IF EXISTS "odr_select" ON public.order_decision_reviews;
CREATE POLICY "odr_select" ON public.order_decision_reviews FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
);

-- INSERT：admin / 订单创建者 / 订单负责人
DROP POLICY IF EXISTS "odr_insert" ON public.order_decision_reviews;
CREATE POLICY "odr_insert" ON public.order_decision_reviews FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- UPDATE：admin / 订单创建者 / 订单负责人（用于写 override 字段）
DROP POLICY IF EXISTS "odr_update" ON public.order_decision_reviews;
CREATE POLICY "odr_update" ON public.order_decision_reviews FOR UPDATE
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
        AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
    )
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_id
        AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid())
    )
  )
);

-- DELETE：仅 admin（决策记录是审计资产，原则上不删）
DROP POLICY IF EXISTS "odr_delete" ON public.order_decision_reviews;
CREATE POLICY "odr_delete" ON public.order_decision_reviews FOR DELETE
USING (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
  )
);

-- ════════════════════════════════════════════════════════════════════════
-- 回滚 SQL（如需撤销）
-- ════════════════════════════════════════════════════════════════════════
--
-- ⚠️ 必须先回滚 04 (order_outcome_reviews) 和 05 (decision_feedback) 才能回滚此表
--
-- DROP TRIGGER IF EXISTS order_decision_reviews_set_updated_at ON public.order_decision_reviews;
-- DROP FUNCTION IF EXISTS public.tg_order_decision_reviews_set_updated_at();
-- DROP INDEX IF EXISTS public.idx_odr_override_pending;
-- DROP INDEX IF EXISTS public.idx_odr_decision_alert;
-- DROP INDEX IF EXISTS public.idx_odr_input_hash;
-- DROP INDEX IF EXISTS public.idx_odr_order_created;
-- ALTER TABLE public.order_decision_reviews RENAME TO order_decision_reviews_failed_20260428;

-- ════════════════════════════════════════════════════════════════════════
-- 冒烟测试
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. 表存在性
--    SELECT EXISTS (SELECT 1 FROM information_schema.tables
--                   WHERE table_schema='public' AND table_name='order_decision_reviews');
--    → true
--
-- 2. CHECK 约束生效（应该插不进去）
--    INSERT INTO public.order_decision_reviews
--      (order_id, review_type, input_hash, triggered_by, decision, confidence,
--       business_audit, financial_audit, feasibility_audit, result_json)
--    SELECT id, 'pre_kickoff', 'test_hash', 'manual', 'INVALID_DECISION', 50,
--           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
--    FROM public.orders LIMIT 1;
--    → 应报错 violates check constraint "odr_decision_chk"
--
-- 3. RLS 启用 + Policy 数量
--    SELECT relrowsecurity FROM pg_class WHERE oid='public.order_decision_reviews'::regclass;
--    → true
--    SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='order_decision_reviews';
--    → 4
--
-- 4. 索引数量
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename='order_decision_reviews';
--    → 5（PK + 4 个 idx_odr_*）
--
-- 5. 验证 CHECK 通过的合法 INSERT（service_role / SQL Editor）
--    INSERT INTO public.order_decision_reviews
--      (order_id, review_type, input_hash, triggered_by, decision, confidence,
--       business_audit, financial_audit, feasibility_audit, result_json)
--    SELECT id, 'pre_kickoff', 'test_hash_smoke', 'manual', 'PROCEED', 100,
--           '{"flags":[],"summary":"smoke"}'::jsonb,
--           '{"flags":[],"summary":"smoke"}'::jsonb,
--           '{"flags":[],"summary":"smoke"}'::jsonb,
--           '{"smoke":true}'::jsonb
--    FROM public.orders LIMIT 1
--    RETURNING id, decision, confidence, ai_used;
--    → 期望：1 行，decision='PROCEED', confidence=100, ai_used=false
--
--    -- 验证完立即删：
--    DELETE FROM public.order_decision_reviews WHERE input_hash='test_hash_smoke';
