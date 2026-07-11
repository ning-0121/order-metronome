-- ===== 2026-07-11 供应商采购对账台账（面料账目导入）=====
-- 背景:采购手工维护一本《面料采购明细表汇总》(每 sheet=一家供应商),要导进系统,
--       建"采购自己的对账台账",将来申请付款/推财务时按【供应商 + 内部订单号 + 金额】对接。
-- 归属:采购对账台账 → 节拍器(本表);付款/排款 → 财务(payable_records)。不双轨,本表只装"该付多少的明细"。
-- 口径:金额一律【不含税】(用户拍板暂不管税);税额/含税等对接财务时再补。
-- 与 procurement_reconciliations(按系统PO)区分:本表是导入的历史/手工账,按自由文本订单号,无系统PO/物料外键。

-- ---------- (1) 导入批次(审计)----------
CREATE TABLE IF NOT EXISTS public.supplier_ledger_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name           text,
  sheet_count         int   NOT NULL DEFAULT 0,          -- 供应商 sheet 数
  row_count           int   NOT NULL DEFAULT 0,          -- 导入明细行数
  total_amount_ex_tax numeric NOT NULL DEFAULT 0,        -- 本批不含税总额
  imported_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- (2) 台账明细(每行=供应商×订单×面料×颜色 一条采购账)----------
CREATE TABLE IF NOT EXISTS public.supplier_fabric_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 供应商(sheet 名原样 + 匹配到主数据,可空=待关联)
  supplier_name_raw  text NOT NULL,
  supplier_id        uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  -- 订单锚点(财务对接①:内部订单号)
  order_no_raw       text,                               -- 订单号列原样(1022918 / PO3301847 / #1022865/102 / 544B)
  internal_order_no  text,                               -- 归一后(抽取的内部单号,可空)
  order_id           uuid REFERENCES public.orders(id) ON DELETE SET NULL,  -- 匹配到系统订单,可空
  -- 物料
  fabric_name        text,
  color              text,
  -- 数量(KG)
  ordered_kg         numeric,                            -- 采购数量
  received_kg        numeric,                            -- 实到数量
  diff_kg            numeric,                            -- 差(采购−实到,超收为负)
  -- 金额(不含税)——财务对接②:应付金额
  unit_price_ex_tax  numeric,                            -- 单价(不含税)
  amount_ex_tax      numeric,                            -- 金额(不含税)
  -- 其他
  invoice_status     text,                               -- 发票状态(没见票 / 已收票 / 已认证 …)
  delivery_note      text,                               -- 备注(送货日期等自由文本)
  customer_name      text,                               -- 客户列(参考)
  -- 导入审计
  import_batch_id    uuid REFERENCES public.supplier_ledger_imports(id) ON DELETE CASCADE,
  source             text NOT NULL DEFAULT 'import',     -- import / manual
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sfl_supplier      ON public.supplier_fabric_ledger(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sfl_supplier_raw  ON public.supplier_fabric_ledger(supplier_name_raw);
CREATE INDEX IF NOT EXISTS idx_sfl_internal_no   ON public.supplier_fabric_ledger(internal_order_no);
CREATE INDEX IF NOT EXISTS idx_sfl_order         ON public.supplier_fabric_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_sfl_batch         ON public.supplier_fabric_ledger(import_batch_id);

-- RLS:登录可读;写走 service-role(action 层校验角色),故只开 SELECT。
ALTER TABLE public.supplier_ledger_imports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_fabric_ledger   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sli_select ON public.supplier_ledger_imports;
CREATE POLICY sli_select ON public.supplier_ledger_imports FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS sfl_select ON public.supplier_fabric_ledger;
CREATE POLICY sfl_select ON public.supplier_fabric_ledger FOR SELECT USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.supplier_fabric_ledger IS
  '供应商采购对账台账(面料账目导入)。每行=供应商×订单×面料×颜色一条采购账,金额不含税。财务对接锚点=supplier_id+internal_order_no+amount_ex_tax。与 procurement_reconciliations(按系统PO)分开:本表是导入的手工账,无系统PO/物料外键。';
