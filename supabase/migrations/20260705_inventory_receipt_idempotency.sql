-- ===== [2026-07-05] 收货入库幂等(复审:recordInventoryReceipt 读-算-写非原子,并发双击重复入库)=====
-- 每条 receipt 流水记录"该采购行累计收货到 X"(receipt_cumulative_qty=当时的 received_qty);
-- (source_ref, txn_type, receipt_cumulative_qty) 唯一 → 同一行同一累计目标只入一条,
-- 并发两次算出同 delta 同 cumulative → 唯一冲突 → ON CONFLICT DO NOTHING,不重复计库。
-- 非 receipt 流水(issue/adjust/return)该列为 null,多 null 在唯一索引中互不冲突,不受影响。

ALTER TABLE public.inventory_transactions ADD COLUMN IF NOT EXISTS receipt_cumulative_qty numeric;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invtxn_receipt_cumulative
  ON public.inventory_transactions (source_ref, txn_type, receipt_cumulative_qty);

-- 回滚:
--   DROP INDEX IF EXISTS uq_invtxn_receipt_cumulative;
--   ALTER TABLE public.inventory_transactions DROP COLUMN IF EXISTS receipt_cumulative_qty;
