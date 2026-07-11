-- ========================================================================
-- 采购对账 + 退货/返修(2026-07-11,P1)—— 采购和供应商完成第一次对账
-- ========================================================================
-- 架构(Constitution 单一真相源/数据所有权):采购对账(收货实况/退货/折扣→净应付)归节拍器,
--   付款/周排款/出纳归财务系统。P2 才把净应付分批推财务(payable.created)。此迁移只建节拍器侧 4 表。
-- 粒度:一 PO 一张对账单(供应商×PO)。连接键 procurement_line_items.id(财务已按此匹配)。
-- 纯加法,不动现有表。⚠️ 人工在 Supabase SQL Editor 执行。
-- ========================================================================

-- 复用的权限口径:采购/采购经理/管理员可读写;财务/管理员可读(P2 推应付/对账核对)。
-- (RLS 做兜底;敏感写在 action 层再把门。)

-- ── 1. 对账单头(一 PO 一张)──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.procurement_reconciliations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id         uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  supplier_id               uuid,
  supplier_name             text,
  status                    text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','confirmed','submitted','paid','cancelled')),
  currency                  text DEFAULT 'RMB',
  system_amount             numeric(14,2) DEFAULT 0,   -- Σ 收货accepted × 单价(系统金额)
  supplier_statement_amount numeric(14,2),             -- 采购录:供应商对账单金额(做差异比对)
  return_amount             numeric(14,2) DEFAULT 0,   -- 退货冲减
  discount_amount           numeric(14,2) DEFAULT 0,   -- 折扣扣款(整单;逐行折扣见明细)
  net_payable               numeric(14,2) DEFAULT 0,   -- 净应付 = 系统 − 退货 − 折扣(P2 分批付款天花板)
  paid_amount               numeric(14,2) DEFAULT 0,   -- 已付累计(payment.completed 回传累加)
  notes                     text,
  confirmed_by              uuid,
  confirmed_at              timestamptz,
  submitted_to_finance_at   timestamptz,
  finance_payable_ref       text,
  paid_at                   timestamptz,
  created_by                uuid,
  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now(),
  UNIQUE (purchase_order_id)
);
CREATE INDEX IF NOT EXISTS idx_recon_po ON public.procurement_reconciliations(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_recon_supplier ON public.procurement_reconciliations(supplier_name);

-- ── 2. 对账明细(一行对一 procurement_line_items)──────────────────────────
CREATE TABLE IF NOT EXISTS public.procurement_reconciliation_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id uuid NOT NULL REFERENCES public.procurement_reconciliations(id) ON DELETE CASCADE,
  line_item_id      uuid REFERENCES public.procurement_line_items(id) ON DELETE SET NULL,
  material_name     text,
  size              text,
  ordered_qty       numeric,          -- 系统:订购
  received_qty      numeric,          -- 系统:收货accepted
  unit_price        numeric,
  supplier_qty      numeric,          -- 采购录:供应商对账单数量
  supplier_amount   numeric(14,2),    -- 采购录:供应商对账单金额
  return_qty        numeric DEFAULT 0,-- 本行退货量(退货单回填)
  line_discount     numeric(14,2) DEFAULT 0,   -- 本行折扣扣款
  net_amount        numeric(14,2),    -- 本行净额 =(收货−退货)×价 − 折扣
  note              text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recon_line_recon ON public.procurement_reconciliation_lines(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_recon_line_pli ON public.procurement_reconciliation_lines(line_item_id);

-- ── 3. 退货/返修单头 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.procurement_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no         text UNIQUE,      -- RT-YYYYMMDD-NNN(app 生成)
  purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  supplier_id       uuid,
  supplier_name     text,
  type              text NOT NULL DEFAULT 'return'
                      CHECK (type IN ('return','replace','rework')),   -- 退货/换货/返修
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','returned','replaced','reworked','closed','cancelled')),
  reason            text,
  total_qty         numeric DEFAULT 0,
  total_amount      numeric(14,2) DEFAULT 0,   -- 退货冲减金额(refund 类)
  attachment_paths  jsonb DEFAULT '[]'::jsonb, -- 退货凭证(order-docs)
  notes             text,
  created_by        uuid,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_po ON public.procurement_returns(purchase_order_id);

-- ── 4. 退货/返修明细 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.procurement_return_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id       uuid NOT NULL REFERENCES public.procurement_returns(id) ON DELETE CASCADE,
  line_item_id    uuid REFERENCES public.procurement_line_items(id) ON DELETE SET NULL,
  goods_receipt_id uuid REFERENCES public.goods_receipts(id) ON DELETE SET NULL,  -- 哪批收货退的
  qty             numeric NOT NULL,
  unit_price      numeric,
  amount          numeric(14,2),
  disposition     text DEFAULT 'refund'
                    CHECK (disposition IN ('refund','replace','rework')),  -- 退款冲应付/换货/返修
  reason          text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_line_ret ON public.procurement_return_lines(return_id);
CREATE INDEX IF NOT EXISTS idx_return_line_pli ON public.procurement_return_lines(line_item_id);

-- ── RLS:采购/采购经理/管理员读写;财务/管理员只读 ──────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['procurement_reconciliations','procurement_reconciliation_lines','procurement_returns','procurement_return_lines']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_rw ON public.%I', t, t);
    -- 读:采购/财务/管理层;写:采购/管理员(FOR ALL,细分在 action 层)
    EXECUTE format($p$
      CREATE POLICY %I_rw ON public.%I FOR ALL USING (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
          AND (p.role IN ('admin','finance','procurement','procurement_manager','admin_assistant')
               OR p.roles && ARRAY['admin','finance','procurement','procurement_manager','admin_assistant']::text[]))
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
          AND (p.role IN ('admin','procurement','procurement_manager')
               OR p.roles && ARRAY['admin','procurement','procurement_manager']::text[]))
      )
    $p$, t, t);
  END LOOP;
END $$;

-- ========================================================================
-- 验证(期望 4 行):SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN
--   ('procurement_reconciliations','procurement_reconciliation_lines','procurement_returns','procurement_return_lines');
-- 策略(期望 4 行):SELECT tablename, policyname FROM pg_policies
--   WHERE tablename LIKE 'procurement_re%' OR tablename LIKE 'procurement_return%';
-- 回滚:DROP TABLE procurement_return_lines, procurement_returns,
--   procurement_reconciliation_lines, procurement_reconciliations CASCADE;
-- ========================================================================
