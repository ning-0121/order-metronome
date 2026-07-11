-- ===== 2026-07-11 供应商台账:税率/含税 + 手动关联 + 推财务应付 =====
-- Part1 税率:单价/金额存不含税,补 tax_rate + amount_incl_tax(生成列,沿用 order_financials.cost_total 生成列惯例,app 永不写)。
-- Part3 推财务:按【供应商 × 订单】建付款申请 supplier_ledger_payables → emit payable.created;
--        ledger 行回写 payable 状态防重推。

-- ---------- Part1:税率 + 含税(生成列)----------
ALTER TABLE public.supplier_fabric_ledger
  ADD COLUMN IF NOT EXISTS tax_rate numeric;                   -- 0.13 = 13%;null=未设(暂按不含税)

ALTER TABLE public.supplier_fabric_ledger
  ADD COLUMN IF NOT EXISTS amount_incl_tax numeric
  GENERATED ALWAYS AS (round(coalesce(amount_ex_tax,0) * (1 + coalesce(tax_rate,0)), 2)) STORED;

-- ---------- Part3:推财务状态(回写在行上,给 UI 显示 + 防重推)----------
ALTER TABLE public.supplier_fabric_ledger
  ADD COLUMN IF NOT EXISTS payable_id      uuid;               -- → supplier_ledger_payables.id
ALTER TABLE public.supplier_fabric_ledger
  ADD COLUMN IF NOT EXISTS payable_bill_no text;               -- 付款申请单号(冗余,给 UI)
ALTER TABLE public.supplier_fabric_ledger
  ADD COLUMN IF NOT EXISTS payable_pushed_at timestamptz;

-- ---------- Part3:台账付款申请(=推给财务的应付)----------
-- 一张 = 一个供应商 × 一个订单(order_no_raw)。金额=含税(有税率)/不含税(无税率)。
CREATE TABLE IF NOT EXISTS public.supplier_ledger_payables (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no            text NOT NULL UNIQUE,                     -- LG-YYYYMMDD-NNN
  supplier_id        uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_name      text NOT NULL,
  order_no_raw       text,                                    -- 台账里的订单号(分组键)
  internal_order_no  text,
  order_id           uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  line_count         int NOT NULL DEFAULT 0,
  amount_ex_tax      numeric NOT NULL DEFAULT 0,
  tax_rate           numeric,                                 -- 该组税率(混合则 null)
  amount_incl_tax    numeric NOT NULL DEFAULT 0,              -- 推给财务的金额
  currency           text NOT NULL DEFAULT 'CNY',
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','void')),
  pushed_by          uuid,
  pushed_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_slp_supplier ON public.supplier_ledger_payables(supplier_id);
CREATE INDEX IF NOT EXISTS idx_slp_order    ON public.supplier_ledger_payables(internal_order_no);

ALTER TABLE public.supplier_ledger_payables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS slp_select ON public.supplier_ledger_payables;
CREATE POLICY slp_select ON public.supplier_ledger_payables FOR SELECT USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.supplier_ledger_payables IS
  '供应商台账付款申请(=推财务应付)。一张=一供应商×一订单;amount_incl_tax 推给财务(payable.created,source_ref=本表id,bill_no 防重付)。付款/排款仍归财务。';
COMMENT ON COLUMN public.supplier_fabric_ledger.amount_incl_tax IS
  '含税金额=不含税×(1+税率),生成列,app 永不写(税率 null 时=不含税)。';
