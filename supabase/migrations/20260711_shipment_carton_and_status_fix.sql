-- ========================================================================
-- 申请出货:加箱数 + 修 status CHECK(2026-07-11)
-- ========================================================================
-- ① 出货申请只有件数,业务要按箱报关/装柜 → 加 carton_count。
-- ② 「提交出货申请保存不了」排查:shipment_confirmations 基表定义不在本仓迁移(schema drift),
--    其 status CHECK 很可能不含全流程状态(sales_signed/warehouse_signed/fully_signed/locked)→
--    createShipmentConfirmation 插 status='sales_signed' 违反 CHECK 而失败。此处放宽 CHECK 到全集
--    (放宽 CHECK 永不破坏既有行,安全)。若保存仍失败=另有原因(看前端红字报错)。
-- 纯加法。⚠️ 人工在 Supabase(节拍器)执行。
-- ========================================================================

ALTER TABLE public.shipment_confirmations
  ADD COLUMN IF NOT EXISTS carton_count int;   -- 出货箱数

-- 放宽 status CHECK 到应用全流程状态(先删旧的过窄约束,名字未知 → 动态查删)
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE n.nspname = 'public' AND rel.relname = 'shipment_confirmations'
    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.shipment_confirmations DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.shipment_confirmations
  ADD CONSTRAINT shipment_confirmations_status_chk
  CHECK (status IN ('pending','sales_signed','warehouse_signed','fully_signed','locked','approved','rejected'));

-- ========================================================================
-- 验证:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='shipment_confirmations' AND column_name='carton_count';   -- 期望 1 行
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='shipment_confirmations_status_chk';
--     -- 期望含 sales_signed/warehouse_signed/fully_signed
-- 回滚:ALTER TABLE public.shipment_confirmations DROP COLUMN carton_count;
--       (status CHECK 放宽不建议回滚)
-- ========================================================================
