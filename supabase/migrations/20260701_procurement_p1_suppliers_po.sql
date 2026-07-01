-- ============================================================
-- 采购 P1 — Supplier Master + 采购单头（纯加法）
-- Supabase: scrtebexbxablybqpdla（QIMO）
-- Date: 2026-07-01
-- 依据: docs/Designs/Procurement-Execution-Flow.md（分叉1=B 拆 suppliers；分叉2=复用价格字段）
-- ------------------------------------------------------------
-- 性质: 纯加法。新增 suppliers + purchase_orders 两表 + procurement_line_items 加 1 列。
--   ❌ 不动 factories / procurement_line_items 现有列/FK（supplier_id→factories 保留 legacy）
--   ❌ 不加价格列（建议价=复用 price_baseline，底价=复用 unit_price）
--   ❌ 不迁历史数据（旧采购行的 factories-supplier 保留，清理放 P2）
-- 反转 2026-06-13「不新建 suppliers」决策：factories 从此只做生产工厂；
--   新采购单的供应商归宿 = suppliers。业务/财务字段分工在 action 层强制。
-- ============================================================

-- ---------- (1) Supplier Master（业务字段 + 财务字段）----------
CREATE TABLE IF NOT EXISTS public.suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code  text UNIQUE,
  -- 业务完善
  name           text NOT NULL,
  address        text,
  phone          text,
  contact_name   text,
  main_category  text,                                   -- 主营品类（fabric/trim/packing/...）
  -- 财务完善
  payment_method text,
  net_days       int,                                    -- 账期（天）
  bank_info      text,
  tax_id         text,
  -- 状态/审计
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON public.suppliers(name);
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppliers_select ON public.suppliers;
CREATE POLICY suppliers_select ON public.suppliers FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS suppliers_insert ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS suppliers_update ON public.suppliers;
CREATE POLICY suppliers_update ON public.suppliers FOR UPDATE USING (auth.uid() IS NOT NULL);
COMMENT ON TABLE public.suppliers IS
  '供应商主数据（原辅料）。业务填 name/address/phone/contact/main_category；财务填 payment_method/net_days/bank/tax（字段级权限在 action 层）。factories 不再当供应商。';

-- ---------- (2) 采购单头（一张单 → 一个供应商；可跨订单）----------
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no         text NOT NULL UNIQUE,                    -- 系统自生 PO-YYYYMMDD-NNN
  supplier_id   uuid NOT NULL REFERENCES public.suppliers(id),
  order_ids     uuid[] NOT NULL DEFAULT '{}',            -- 关联订单（可跨）；内部单号从 orders.internal_order_no 派生显示（双号）
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','placed','confirmed','receiving','received','closed','cancelled')),
  currency      text DEFAULT 'RMB',
  total_amount  numeric(14,2),
  payment_terms text,
  delivery_date date,
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON public.purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status   ON public.purchase_orders(status);
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purchase_orders_select ON public.purchase_orders;
CREATE POLICY purchase_orders_select ON public.purchase_orders FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS purchase_orders_insert ON public.purchase_orders;
CREATE POLICY purchase_orders_insert ON public.purchase_orders FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS purchase_orders_update ON public.purchase_orders;
CREATE POLICY purchase_orders_update ON public.purchase_orders FOR UPDATE USING (auth.uid() IS NOT NULL);
COMMENT ON TABLE public.purchase_orders IS
  '采购单头（我方→供应商）。行=procurement_line_items(+purchase_order_id)。建议价复用行 price_baseline，大货底价复用行 unit_price（业务隐藏 unit_price）。';

-- ---------- (3) procurement_line_items 归行到单（只加 1 列）----------
ALTER TABLE public.procurement_line_items
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES public.purchase_orders(id);
CREATE INDEX IF NOT EXISTS idx_pli_purchase_order ON public.procurement_line_items(purchase_order_id);

-- ============================================================
-- 验证 SQL（DB 门禁 — Supabase SQL Editor 单独运行）
-- ------------------------------------------------------------
-- [1] 两新表存在（期望 2 行）
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' AND table_name IN ('suppliers','purchase_orders') ORDER BY 1;
--
-- [2] suppliers 列（业务+财务字段齐）
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='suppliers' ORDER BY ordinal_position;
--   期望含: name,address,phone,contact_name,main_category,payment_method,net_days,bank_info,tax_id,status
--
-- [3] purchase_orders FK → suppliers 存在
-- SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='purchase_orders' AND con.contype='f' AND pg_get_constraintdef(con.oid) ILIKE '%suppliers%';
--
-- [4] procurement_line_items 新列 purchase_order_id 存在（期望 1 行）
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='procurement_line_items' AND column_name='purchase_order_id';
--
-- [5] 复用价格列仍在（期望 price_baseline + unit_price 两行）
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='procurement_line_items'
--   AND column_name IN ('price_baseline','unit_price') ORDER BY 1;
--
-- [6] 现有采购未受损（supplier_id→factories 仍在，行数>0 不变）
-- SELECT count(*) AS pli_rows FROM public.procurement_line_items;
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='procurement_line_items' AND column_name='supplier_id';
--
-- [7] RLS 启用（suppliers / purchase_orders 均 true）
-- SELECT c.relname, c.relrowsecurity FROM pg_class c
-- WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('suppliers','purchase_orders');
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行）
-- ------------------------------------------------------------
-- ALTER TABLE public.procurement_line_items DROP COLUMN IF EXISTS purchase_order_id;
-- DROP TABLE IF EXISTS public.purchase_orders;   -- 索引/策略随表 DROP
-- DROP TABLE IF EXISTS public.suppliers;
-- 注: factories / procurement_line_items 原有列/FK 未动，无需回滚。
-- ============================================================
