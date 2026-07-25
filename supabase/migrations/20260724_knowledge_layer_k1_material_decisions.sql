-- ========================================================================
-- QIMO OS — Knowledge Layer K1:material_decisions（Material Decision Capture）
-- ========================================================================
-- 目的:补上 2A(20260629_materials_bom_product_link_2a)主动推迟的「override 明细表」——
--   append-only 记录每次 Material Override 的:原因(结构化码)/ before-after / 证据 / 预估影响 / 结果。
-- 纯加法:仅新建 1 表 + 5 索引 + RLS。**不动** materials_bom / product_bom_templates /
--   order_attachments / order_logs 任何现有列;**不改** B1(submitBomToProcurement)/P1′(consolidate) 读取;
--   新表全空、无回填、无触发器、无灌数据。旧行零影响。
-- 复用:证据指向 order_attachments(不建证据表);append-only 轨迹落 order_logs(不建 business_events);
--   可见性用 user_can_access_order(20260408/20260425);更正走 supersede(仿 material_package_snapshots)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行 + 跑文末 8 项数据库门禁;Claude 不执行、未 push。
-- 回滚:DROP TABLE 即可(新表空、现有表未改结构、代码在 flag=off 时不触碰本表)。
-- ========================================================================

CREATE TABLE IF NOT EXISTS public.material_decisions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── 关联(显式 FK,跟随订单可见性)──
  order_id                uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  bom_id                  uuid REFERENCES public.materials_bom(id) ON DELETE SET NULL,          -- live 行可能被删/改,SET NULL 保历史
  product_bom_template_id uuid REFERENCES public.product_bom_templates(id) ON DELETE SET NULL,  -- 来源模板行(可空)
  material_master_id      uuid REFERENCES public.material_master(id) ON DELETE SET NULL,

  -- ── 物料身份快照(反范式,行删了也可读)──
  material_name           text NOT NULL,
  material_code           text,

  -- ── 决策事实(confirmed 后 write-once;更正=新行 supersede)──
  decision_type           text NOT NULL CHECK (decision_type IN
                            ('consumption_change','material_swap','line_add','line_delete',
                             'qty_override','supplier_change','other')),
  reason_code             text NOT NULL CHECK (reason_code IN
                            ('customer_request','supplier_substitute','price_optimization','lead_time',
                             'quality_issue','consumption_correction','sample_feedback','moq_or_packing',
                             'stock_reuse','spec_change','data_entry_fix','other')),
  reason_note             text,
  before_json             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 改前值(现有 schema 存不下的)
  after_json              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 改后值
  estimated_impact_qty    numeric,
  estimated_impact_amount numeric,                              -- ⚠️ 价格敏感,service 层对部分角色屏蔽
  impact_currency         text,

  -- ── 证据(复用 order_attachments;指针数组,无 FK 免碰热表)──
  evidence_refs           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{attachment_id|url, note}]

  -- ── 范围绑定(K2 知识蒸馏用,决策时打戳;可空)──
  scope_json              jsonb,                                -- {customer, product_category, material_category, factory}

  -- ── 溯源 + 谁/何时 ──
  source                  text NOT NULL DEFAULT 'human' CHECK (source IN ('human','ai','rule')),
  actor_id                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at              timestamptz NOT NULL DEFAULT now(),

  -- ── 状态机(K1 只实现 Decision 状态)──
  status                  text NOT NULL DEFAULT 'confirmed' CHECK (status IN
                            ('draft','confirmed','outcome_pending','evaluated','closed','superseded')),
  supersedes_decision_id  uuid REFERENCES public.material_decisions(id) ON DELETE SET NULL,

  -- ── Outcome(后填,读时不阻塞;自动信号 + 人工因果判定)──
  outcome_result          text CHECK (outcome_result IS NULL OR outcome_result IN
                            ('correct','too_low_caused_supplement','too_high_caused_waste','inconclusive')),
  outcome_auto_signals    jsonb,                                -- 投影器:{is_supplement,supplement_qty,difference_pct,cost_variance_pct}
  outcome_was_correct     boolean,                              -- 人工因果判定(≠自动信号)
  outcome_attributed_cause text,
  outcome_note            text,
  evaluated_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  evaluated_at            timestamptz,

  -- ── 标准时间戳 ──
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- other 原因码必须写说明(仿 decision_feedback 的 override_reason 强约束,不允许静默 other)
  CONSTRAINT md_reason_note_required_chk
    CHECK (reason_code <> 'other' OR (reason_note IS NOT NULL AND length(trim(reason_note)) >= 5))
);

CREATE INDEX IF NOT EXISTS idx_md_order_id    ON public.material_decisions(order_id);
CREATE INDEX IF NOT EXISTS idx_md_bom_id      ON public.material_decisions(bom_id)                  WHERE bom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_md_template_id ON public.material_decisions(product_bom_template_id) WHERE product_bom_template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_md_status      ON public.material_decisions(status);
CREATE INDEX IF NOT EXISTS idx_md_reason_code ON public.material_decisions(reason_code);

-- ── RLS:跟随订单可见性(复用现有 helper);写入者=本人;更新限有订单权限者 ──
ALTER TABLE public.material_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS md_sel ON public.material_decisions;
CREATE POLICY md_sel ON public.material_decisions FOR SELECT
  USING (public.user_can_access_order(auth.uid(), order_id));

DROP POLICY IF EXISTS md_ins ON public.material_decisions;
CREATE POLICY md_ins ON public.material_decisions FOR INSERT
  WITH CHECK (public.user_can_access_order(auth.uid(), order_id) AND actor_id = auth.uid());

DROP POLICY IF EXISTS md_upd ON public.material_decisions;
CREATE POLICY md_upd ON public.material_decisions FOR UPDATE
  USING (public.user_can_access_order(auth.uid(), order_id));
-- 注:facts write-once 由 app/service 层保证(K1 靠约定 + code review;K1.1 可加列级触发器)。
--    Outcome 投影器用 service-role 写 outcome_*(绕 RLS,仿 runtime_orders)。

-- ========================================================================
-- 8 项数据库门禁(执行后逐条跑,真实返回,出 PASS/FAIL)
-- ========================================================================
-- ① 表存在(期望 1 行)
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='material_decisions';
-- ② 字段齐(期望列数 = 31)
-- SELECT count(*) FROM information_schema.columns WHERE table_name='material_decisions';
-- ③ FK 删除规则:order_id=CASCADE(c);bom_id/template/master/actor/evaluated_by/supersedes=SET NULL(n)
-- SELECT conname, confrelid::regclass AS ref, confdeltype FROM pg_constraint
--   WHERE conrelid='public.material_decisions'::regclass AND contype='f' ORDER BY conname;
-- ④ UNIQUE:K1 仅 PK,无额外 UNIQUE(期望 0 行)
-- SELECT conname FROM pg_constraint WHERE conrelid='public.material_decisions'::regclass AND contype='u';
-- ⑤ Index 存在(期望 5 个 idx_md_*)
-- SELECT indexname FROM pg_indexes WHERE tablename='material_decisions' AND indexname LIKE 'idx_md_%';
-- ⑥ RLS 开(期望 t)
-- SELECT relrowsecurity FROM pg_class WHERE relname='material_decisions';
-- ⑦ 行数(期望 0,K1 不灌数据)
-- SELECT count(*) FROM public.material_decisions;
-- ⑧ CHECK 生效(decision_type/reason_code/status/outcome_result/source/md_reason_note_required_chk = 6 个 CHECK)
-- SELECT conname FROM pg_constraint WHERE conrelid='public.material_decisions'::regclass AND contype='c' ORDER BY conname;

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净:新表空、现有表未改结构、flag=off 时代码不触碰本表)
-- ========================================================================
-- DROP TABLE IF EXISTS public.material_decisions;
