-- ============================================================
-- 库存 W0 — inventory_transactions（append-only 库存流水）
-- Supabase: scrtebexbxablybqpdla（QIMO）
-- Date: 2026-07-02
-- 依据: docs/Domains/Warehouse-Inventory-Domain-V1.md（W0）
-- ------------------------------------------------------------
-- 性质: 纯加法。1 张 append-only 账本表。余额=派生(读时 Σ,不建 warehouse_inventory 表)。
--   入库自动(采购收货增量 delta);领料/退料/盘点(issue/return/adjust)=W1。
--   append-only:无 UPDATE/DELETE policy + BEFORE UPDATE/DELETE 触发器双保险;纠错走反向流水。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_key  text NOT NULL,                         -- 复用 consolidation_key
  material_name text,
  unit          text,
  txn_type      text NOT NULL CHECK (txn_type IN ('receipt','issue','return','adjust','scrap')),
  qty           numeric NOT NULL,                      -- 带符号(receipt/return/+adjust 为+;issue/scrap 为−)
  order_id      uuid REFERENCES public.orders(id),     -- 领料/退料挂单,可空
  source_ref    uuid,                                  -- 入库→procurement_line_item_id;领料→manufacturing_order_id
  location      text,                                  -- 多库位留位
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  note          text
);
CREATE INDEX IF NOT EXISTS idx_invtxn_material ON public.inventory_transactions(material_key);
CREATE INDEX IF NOT EXISTS idx_invtxn_order    ON public.inventory_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_invtxn_source   ON public.inventory_transactions(source_ref);

ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invtxn_select ON public.inventory_transactions;
CREATE POLICY invtxn_select ON public.inventory_transactions FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS invtxn_insert ON public.inventory_transactions;
CREATE POLICY invtxn_insert ON public.inventory_transactions FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- append-only:无 UPDATE/DELETE policy + 触发器双保险
CREATE OR REPLACE FUNCTION public.block_invtxn_mutate() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'inventory_transactions is append-only; 纠错请写反向流水'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_invtxn_immutable ON public.inventory_transactions;
CREATE TRIGGER trg_invtxn_immutable BEFORE UPDATE OR DELETE ON public.inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION public.block_invtxn_mutate();

COMMENT ON TABLE public.inventory_transactions IS
  '库存流水(append-only,唯一真相)。余额=派生 Σ。入库自动(收货增量);领料/退料=W1。纠错走反向流水,不改历史。';

-- ============================================================
-- 验证 SQL（DB 门禁 — 单独运行）
-- ------------------------------------------------------------
-- [1] 表存在
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='inventory_transactions';
-- [2] txn_type CHECK
-- SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
-- WHERE t.relname='inventory_transactions' AND con.contype='c';
-- [3] append-only 触发器在（改/删被拒）
-- SELECT tgname FROM pg_trigger WHERE tgrelid='public.inventory_transactions'::regclass AND NOT tgisinternal;
--   手验:INSERT 一行 → UPDATE/DELETE 它应报 'append-only';测完 DELETE 会被拒(用反向流水或 truncate 测试库)
-- [4] RLS 启用
-- SELECT relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname='inventory_transactions';
-- ============================================================

-- ============================================================
-- 回滚 SQL
-- ------------------------------------------------------------
-- DROP TRIGGER IF EXISTS trg_invtxn_immutable ON public.inventory_transactions;
-- DROP FUNCTION IF EXISTS public.block_invtxn_mutate();
-- DROP TABLE IF EXISTS public.inventory_transactions;
-- ============================================================
