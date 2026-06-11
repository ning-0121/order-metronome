-- ===== 20260613 Procurement Center V1（止血闭环）=====
-- 契约：docs/procurement-center-design.md §11。幂等，可重复执行。
-- ⚠️ 已于 2026-06-13 在生产 SQL Editor 执行（Step A 验证 v1_migration_applied=1），本文件为 repo 存档。

-- ── 1. factories 供应商扩展（决策2：不新建 suppliers）──
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS payment_terms     text;
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS default_lead_days int;
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS moq_notes         text;
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS contact_wechat    text;
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS supplier_grade    text
  CHECK (supplier_grade IS NULL OR supplier_grade IN ('A','B','C','D'));
ALTER TABLE public.factories ADD COLUMN IF NOT EXISTS grade_updated_at  timestamptz;

-- ── 2. procurement_line_items 扩展（决策1：唯一执行行表）──
ALTER TABLE public.procurement_line_items
  ADD COLUMN IF NOT EXISTS supplier_id      uuid REFERENCES public.factories(id),
  ADD COLUMN IF NOT EXISTS line_status      text NOT NULL DEFAULT 'draft'
    CHECK (line_status IN ('draft','pending_order','ordered','confirmed',
                           'in_production','shipped','arrived',
                           'accepted','concession','rejected','closed','cancelled')),
  ADD COLUMN IF NOT EXISTS required_by      date,
  ADD COLUMN IF NOT EXISTS promised_date    date,
  ADD COLUMN IF NOT EXISTS expected_arrival date,
  ADD COLUMN IF NOT EXISTS po_no            text,
  ADD COLUMN IF NOT EXISTS confirmed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS shipped_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_chased_at   timestamptz,
  ADD COLUMN IF NOT EXISTS chase_count      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_baseline   numeric,
  ADD COLUMN IF NOT EXISTS is_supplement     boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS supplement_reason text,
  ADD COLUMN IF NOT EXISTS approved_by_name  text,
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz;

ALTER TABLE public.procurement_line_items
  ADD COLUMN IF NOT EXISTS price_variance_pct numeric GENERATED ALWAYS AS (
    CASE WHEN price_baseline IS NOT NULL AND price_baseline > 0 AND unit_price IS NOT NULL
         THEN round((unit_price - price_baseline) / price_baseline * 100, 1)
         ELSE NULL END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_pli_line_status ON public.procurement_line_items(line_status, required_by);
CREATE INDEX IF NOT EXISTS idx_pli_supplier    ON public.procurement_line_items(supplier_id);

-- ── 3. goods_receipts（到货验收，一行可多批）──
CREATE TABLE IF NOT EXISTS public.goods_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_item_id  uuid NOT NULL REFERENCES public.procurement_line_items(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  received_qty  numeric NOT NULL,
  received_unit text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_by   uuid REFERENCES auth.users(id),
  inspection_result text NOT NULL DEFAULT 'pending'
    CHECK (inspection_result IN ('pending','pass','concession','reject')),
  aql_level     text,
  defect_notes  text,
  concession_approved_by uuid REFERENCES auth.users(id),
  return_required boolean DEFAULT false,
  return_status   text CHECK (return_status IS NULL OR return_status IN ('pending','returned','replaced','waived')),
  photos        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gr_line  ON public.goods_receipts(line_item_id);
CREATE INDEX IF NOT EXISTS idx_gr_order ON public.goods_receipts(order_id);

-- ── 4. procurement_logs（复制 milestone_logs 结构）──
CREATE TABLE IF NOT EXISTS public.procurement_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_item_id  uuid NOT NULL REFERENCES public.procurement_line_items(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id),
  action        text NOT NULL CHECK (action IN
    ('status_transition','chase','receive','inspect','approve','override','cancel','update')),
  from_status   text,
  to_status     text,
  note          text,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plog_line ON public.procurement_logs(line_item_id, created_at DESC);

-- ── 5. price_history（每次下单自动写；V2 再加 material_id FK）──
CREATE TABLE IF NOT EXISTS public.price_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  line_item_id  uuid REFERENCES public.procurement_line_items(id) ON DELETE SET NULL,
  supplier_id   uuid REFERENCES public.factories(id),
  material_name text NOT NULL,
  specification text,
  category      text,
  unit_price    numeric NOT NULL,
  currency      text DEFAULT 'CNY',
  unit          text,
  qty           numeric,
  quoted_at     timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL DEFAULT 'order' CHECK (source IN ('order','quote','market')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ph_material ON public.price_history(material_name, supplier_id, quoted_at DESC);

-- ── 6. procurement_matters（克隆 customer_matters 模式）──
CREATE TABLE IF NOT EXISTS public.procurement_matters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no        text,
  supplier_id     uuid REFERENCES public.factories(id),
  line_item_id    uuid REFERENCES public.procurement_line_items(id) ON DELETE CASCADE,
  matter_type     text NOT NULL CHECK (matter_type IN
    ('material_shortage','supplier_delay','price_anomaly','quality_reject','chase_stalled','risk_schedule')),
  severity        text NOT NULL CHECK (severity IN ('high','medium')),
  title           text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source          text NOT NULL,
  source_ref      text NOT NULL,
  matter_key      text NOT NULL,
  detected_at     timestamptz NOT NULL,
  materialized_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS procurement_matters_key_idx ON public.procurement_matters(matter_key);

-- ── 7. RLS ──
ALTER TABLE public.goods_receipts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_matters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gr_select_auth"  ON public.goods_receipts;
CREATE POLICY "gr_select_auth"  ON public.goods_receipts  FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "gr_insert_auth"  ON public.goods_receipts;
CREATE POLICY "gr_insert_auth"  ON public.goods_receipts  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "gr_update_auth"  ON public.goods_receipts;
CREATE POLICY "gr_update_auth"  ON public.goods_receipts  FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "plog_select_auth" ON public.procurement_logs;
CREATE POLICY "plog_select_auth" ON public.procurement_logs FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "plog_insert_auth" ON public.procurement_logs;
CREATE POLICY "plog_insert_auth" ON public.procurement_logs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "ph_select_auth" ON public.price_history;
CREATE POLICY "ph_select_auth" ON public.price_history FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "ph_insert_auth" ON public.price_history;
CREATE POLICY "ph_insert_auth" ON public.price_history FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- matters：只建 SELECT（service-role 写），同 customer_matters
DROP POLICY IF EXISTS "pm_select_auth" ON public.procurement_matters;
CREATE POLICY "pm_select_auth" ON public.procurement_matters FOR SELECT USING (auth.uid() IS NOT NULL);
