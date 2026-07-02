-- ========================================================================
-- QIMO SCM OS — SC-P2 库存真相层(仓库维度 + 预留 + 可用量)
-- ========================================================================
-- 依据: docs/Designs/SCM-OS-Completion-Blueprint-V1.md §B(P2)。
-- 让库存变"可信、不重叠、预留感知、计算驱动": available = onHand − reserved − safety。
-- 性质: 纯加法。2 张新表(warehouse / inventory_reservation)+ inventory_transactions 加 2 列。
--   ❌ 不改 inventory_transactions 既有列/append-only 逻辑/触发器;不回填历史(触发器禁 UPDATE)。
--   ❌ material_master 的 safety_stock_qty/reorder_point/max_stock 已在 SC-P1 加,本迁移不重复。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

-- ── 1) warehouse:仓库(激活 location 维度)──
CREATE TABLE IF NOT EXISTS public.warehouse (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL DEFAULT 'main' CHECK (type IN ('main','external','supplier','qc')),
  is_default  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_default ON public.warehouse(is_default) WHERE is_default = true; -- 至多一个默认仓
COMMENT ON TABLE public.warehouse IS '仓库主数据。inventory_transactions.warehouse_id / inventory_reservation.warehouse_id 引用。';

-- ── 2) inventory_reservation:预留账(逻辑锁;可变状态,故独立于 append-only 账本)──
CREATE TABLE IF NOT EXISTS public.inventory_reservation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_key         text NOT NULL,                          -- 复用 consolidationKey,与 inventory_transactions 同口径
  material_master_id   uuid REFERENCES public.material_master(id) ON DELETE SET NULL,
  order_id             uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  procurement_item_id  uuid REFERENCES public.procurement_items(id) ON DELETE SET NULL,
  warehouse_id         uuid REFERENCES public.warehouse(id) ON DELETE SET NULL,
  qty                  numeric NOT NULL CHECK (qty > 0),
  status               text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','consumed')),
  source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('order','procurement','manual')),
  note                 text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz,
  consumed_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_resv_key_status ON public.inventory_reservation(material_key, status);
CREATE INDEX IF NOT EXISTS idx_resv_order      ON public.inventory_reservation(order_id);
CREATE INDEX IF NOT EXISTS idx_resv_warehouse  ON public.inventory_reservation(warehouse_id);
COMMENT ON TABLE public.inventory_reservation IS '预留账(逻辑锁)。available=onHand−Σ(status=reserved)−safety。reserved→released(取消)/consumed(领料出库)。';

-- ── 3) inventory_transactions 加 2 个可空关系列(不改 append-only 逻辑;不回填历史)──
ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS warehouse_id   uuid REFERENCES public.warehouse(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reservation_id uuid REFERENCES public.inventory_reservation(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invtxn_warehouse ON public.inventory_transactions(warehouse_id);

-- ── 4) RLS(登录可读/写;写权限在 action 层按角色把关)──
ALTER TABLE public.warehouse             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_reservation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wh_sel ON public.warehouse;
CREATE POLICY wh_sel ON public.warehouse FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS wh_ins ON public.warehouse;
CREATE POLICY wh_ins ON public.warehouse FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS wh_upd ON public.warehouse;
CREATE POLICY wh_upd ON public.warehouse FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS resv_sel ON public.inventory_reservation;
CREATE POLICY resv_sel ON public.inventory_reservation FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS resv_ins ON public.inventory_reservation;
CREATE POLICY resv_ins ON public.inventory_reservation FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS resv_upd ON public.inventory_reservation;
CREATE POLICY resv_upd ON public.inventory_reservation FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ========================================================================
-- 验证 SQL(执行后单独跑)
-- ========================================================================
-- [1] 2 张新表存在(期望 2)
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('warehouse','inventory_reservation');
-- [2] inventory_transactions 2 个新列(期望 2)
-- SELECT count(*) FROM information_schema.columns WHERE table_name='inventory_transactions' AND column_name IN ('warehouse_id','reservation_id');
-- [3] inventory_reservation 的 FK 数(期望 4:material_master/orders/procurement_items/warehouse)
-- SELECT count(*) FROM pg_constraint WHERE conrelid='public.inventory_reservation'::regclass AND contype='f';
-- [4] append-only 触发器仍在(未被动过;期望 1)
-- SELECT count(*) FROM pg_trigger WHERE tgrelid='public.inventory_transactions'::regclass AND tgname='trg_invtxn_immutable';
-- [5] RLS 启用(期望 2 行 t)
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('warehouse','inventory_reservation');
-- [6] 新表全空 + 历史流水 warehouse_id 未回填(期望 resv=0, txn_wh=0)
-- SELECT (SELECT count(*) FROM inventory_reservation) resv, (SELECT count(*) FROM inventory_transactions WHERE warehouse_id IS NOT NULL) txn_wh;

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净)
-- ========================================================================
-- ALTER TABLE public.inventory_transactions DROP COLUMN IF EXISTS reservation_id, DROP COLUMN IF EXISTS warehouse_id;
-- DROP TABLE IF EXISTS public.inventory_reservation;
-- DROP TABLE IF EXISTS public.warehouse;
