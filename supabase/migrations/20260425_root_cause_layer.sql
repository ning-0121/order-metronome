-- ════════════════════════════════════════════════════════════════════════
-- 订单节拍器下一阶段总优化 — Step 1
-- 主题：Root Cause Engine + Business Decision Engine + Data Asset Layer
-- 日期：2026-04-25
-- 原则：仅建表 + 预留 + RLS，不修改现有任何对象
-- ════════════════════════════════════════════════════════════════════════

-- ───────────── 1. 通用 helper：user_can_see_financial ─────────────
-- 用于敏感原因（profit / payment domain）的可见性控制
CREATE OR REPLACE FUNCTION public.user_can_see_financial(uid uuid, oid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    -- admin / finance：全可见
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = uid
        AND (
          p.role IN ('admin','finance')
          OR (p.roles && ARRAY['admin','finance']::text[])
        )
    )
    -- 订单创建者 / 业务负责人：可见
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = oid
        AND (o.created_by = uid OR o.owner_user_id = uid)
    );
$$;

GRANT EXECUTE ON FUNCTION public.user_can_see_financial(uuid, uuid) TO authenticated;

-- ───────────── 2. company_settings：多租户预留 + 引擎开关 ─────────────
CREATE TABLE IF NOT EXISTS public.company_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid UNIQUE,                      -- NULL = 默认配置（本期单 row）

  -- 数据资产层合规开关
  allow_internal_analytics      boolean NOT NULL DEFAULT true,
  allow_anonymized_benchmark    boolean NOT NULL DEFAULT false,
  allow_model_training          boolean NOT NULL DEFAULT false,
  data_retention_days           int     NOT NULL DEFAULT 1825,
  pii_policy_level              text    NOT NULL DEFAULT 'strict'
                                  CHECK (pii_policy_level IN ('strict','standard','loose')),

  -- 三大引擎运行开关（与 env 同步，env 为主，此处兜底）
  root_cause_engine_enabled        boolean NOT NULL DEFAULT false,
  business_decision_engine_enabled boolean NOT NULL DEFAULT false,
  data_asset_layer_enabled         boolean NOT NULL DEFAULT false,

  -- 匿名化盐（用于 hash customer_id / factory_id）
  anonymization_salt    text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 默认配置 row（company_id IS NULL）
INSERT INTO public.company_settings (company_id, anonymization_salt)
VALUES (NULL, encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (company_id) DO NOTHING;

-- RLS：只有 admin 可读（盐值敏感）
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_settings_admin_select" ON public.company_settings;
CREATE POLICY "company_settings_admin_select" ON public.company_settings FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
  )
);

DROP POLICY IF EXISTS "company_settings_admin_update" ON public.company_settings;
CREATE POLICY "company_settings_admin_update" ON public.company_settings FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.role = 'admin' OR (p.roles && ARRAY['admin']::text[]))
  )
);

-- ───────────── 3. order_root_causes：根因主表 ─────────────
CREATE TABLE IF NOT EXISTS public.order_root_causes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  company_id          uuid,

  cause_domain        text NOT NULL CHECK (cause_domain IN (
    'delay','profit','payment','quality','confirmation','logistics','factory','customer'
  )),
  cause_type          text NOT NULL CHECK (cause_type IN (
    'CLIENT_DELAY','FACTORY_DELAY','MATERIAL_DELAY','PACKAGING_DELAY',
    'INTERNAL_ERROR','LOGISTICS_DELAY','PAYMENT_ISSUE','QUALITY_ISSUE',
    'LOW_MARGIN','CONFIRMATION_MISSING'
  )),
  cause_code          text NOT NULL,                -- 规则 code，如 'PAYMENT_BLOCKING_PRODUCTION'
  cause_title         text NOT NULL,
  cause_description   text,

  stage               text CHECK (stage IS NULL OR stage IN ('A','B','C','D')),
  responsible_role    text,
  responsible_user_id uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,

  impact_days         int     NOT NULL DEFAULT 0,
  impact_cost         numeric(12,2) NOT NULL DEFAULT 0,
  severity            text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  confidence_score    numeric(3,2) NOT NULL DEFAULT 1.0
                        CHECK (confidence_score BETWEEN 0 AND 1),
  source              text NOT NULL CHECK (source IN ('rule','ai','manual')),
  evidence_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','confirmed','dismissed','resolved')),

  created_by          uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  resolution_note     text
);

-- 幂等键：同一订单同一 code 同一 stage 只允许一条 active
-- (允许同 code 在不同 stage 各有一条；resolved/dismissed 不参与冲突)
CREATE UNIQUE INDEX IF NOT EXISTS uq_root_causes_active
  ON public.order_root_causes (order_id, cause_code, COALESCE(stage,''))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_root_causes_order
  ON public.order_root_causes (order_id);

CREATE INDEX IF NOT EXISTS idx_root_causes_status_active
  ON public.order_root_causes (status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_root_causes_domain
  ON public.order_root_causes (cause_domain, status);

CREATE INDEX IF NOT EXISTS idx_root_causes_company
  ON public.order_root_causes (company_id) WHERE company_id IS NOT NULL;

-- updated_at 触发器
CREATE OR REPLACE FUNCTION public.tg_root_causes_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS root_causes_set_updated_at ON public.order_root_causes;
CREATE TRIGGER root_causes_set_updated_at
  BEFORE UPDATE ON public.order_root_causes
  FOR EACH ROW EXECUTE FUNCTION public.tg_root_causes_set_updated_at();

-- RLS：能看订单 → 能看根因；profit/payment domain 额外要求金融可见权限
ALTER TABLE public.order_root_causes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rc_select" ON public.order_root_causes;
CREATE POLICY "rc_select" ON public.order_root_causes FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND public.user_can_access_order(auth.uid(), order_id)
  AND (
    cause_domain NOT IN ('profit','payment')
    OR public.user_can_see_financial(auth.uid(), order_id)
  )
);

-- INSERT：admin / 订单创建者 / 订单负责人 / service_role
DROP POLICY IF EXISTS "rc_insert" ON public.order_root_causes;
CREATE POLICY "rc_insert" ON public.order_root_causes FOR INSERT
WITH CHECK (
  auth.uid() IS NOT NULL
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

-- UPDATE：admin 可改任意；订单创建者只能改 status / resolution_note
DROP POLICY IF EXISTS "rc_update" ON public.order_root_causes;
CREATE POLICY "rc_update" ON public.order_root_causes FOR UPDATE
USING (
  auth.uid() IS NOT NULL
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

-- ───────────── 4. customer_analytics：客户画像聚合（Step 4 用，本期空表） ─────────────
CREATE TABLE IF NOT EXISTS public.customer_analytics (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid,
  customer_id_hash         text NOT NULL,
  customer_segment         text,
  country                  text,
  avg_margin               numeric(5,2),
  avg_payment_days         numeric(5,1),
  avg_delay_days           numeric(5,1),
  confirmation_delay_avg   numeric(5,1),
  complaint_rate           numeric(5,4),
  repeat_order_rate        numeric(5,4),
  risk_score               numeric(5,2),
  sample_size              int NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, customer_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_customer_analytics_company
  ON public.customer_analytics (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.customer_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ca_admin_select" ON public.customer_analytics;
CREATE POLICY "ca_admin_select" ON public.customer_analytics FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.role IN ('admin','finance')
        OR (p.roles && ARRAY['admin','finance']::text[])
      )
  )
);

-- ───────────── 5. factory_analytics ─────────────
CREATE TABLE IF NOT EXISTS public.factory_analytics (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid,
  factory_id_hash     text NOT NULL,
  factory_segment     text,
  product_category    text,
  delay_rate          numeric(5,4),
  avg_delay_days      numeric(5,1),
  defect_rate         numeric(5,4),
  rework_rate         numeric(5,4),
  qc_pass_rate        numeric(5,4),
  avg_lead_time       numeric(5,1),
  capacity_score      numeric(5,2),
  risk_score          numeric(5,2),
  sample_size         int NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, factory_id_hash, product_category)
);

CREATE INDEX IF NOT EXISTS idx_factory_analytics_company
  ON public.factory_analytics (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.factory_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fa_admin_select" ON public.factory_analytics;
CREATE POLICY "fa_admin_select" ON public.factory_analytics FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.role IN ('admin','finance','production_manager')
        OR (p.roles && ARRAY['admin','finance','production_manager']::text[])
      )
  )
);

-- ───────────── 6. order_model_analytics：行业 benchmark 种子 ─────────────
CREATE TABLE IF NOT EXISTS public.order_model_analytics (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid,
  product_category         text,
  country                  text,
  incoterm                 text,
  order_size_bucket        text,
  margin_avg               numeric(5,2),
  margin_p25               numeric(5,2),
  margin_p50               numeric(5,2),
  margin_p75               numeric(5,2),
  delay_avg_days           numeric(5,1),
  defect_rate_avg          numeric(5,4),
  payment_delay_avg        numeric(5,1),
  confirmation_rounds_avg  numeric(5,2),
  sample_size              int NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_category, country, incoterm, order_size_bucket)
);

CREATE INDEX IF NOT EXISTS idx_order_model_analytics_company
  ON public.order_model_analytics (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.order_model_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "oma_admin_select" ON public.order_model_analytics;
CREATE POLICY "oma_admin_select" ON public.order_model_analytics FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.role IN ('admin','finance')
        OR (p.roles && ARRAY['admin','finance']::text[])
      )
  )
);

-- ════════════════════════════════════════════════════════════════════════
-- 回滚脚本（如需撤销）：
--   DROP TABLE IF EXISTS public.order_root_causes      CASCADE;
--   DROP TABLE IF EXISTS public.customer_analytics     CASCADE;
--   DROP TABLE IF EXISTS public.factory_analytics      CASCADE;
--   DROP TABLE IF EXISTS public.order_model_analytics  CASCADE;
--   DROP TABLE IF EXISTS public.company_settings       CASCADE;
--   DROP FUNCTION IF EXISTS public.user_can_see_financial(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.tg_root_causes_set_updated_at();
-- ════════════════════════════════════════════════════════════════════════
