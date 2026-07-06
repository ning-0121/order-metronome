-- ============================================================
-- 20260706_admin_purge_order —— 管理员彻底清除"已取消订单"(含 append-only 库存流水)
-- ------------------------------------------------------------
-- 背景:inventory_transactions 是 append-only 账本(无 UPDATE/DELETE policy + BEFORE UPDATE/DELETE
--       触发器 trg_invtxn_immutable),且 order_id 是 RESTRICT 外键 → 有库存流水的订单永远物理删不掉。
--       正常业务应"取消"而非删除。但测试单需要真正清库时,给管理员一个受控出口。
-- 性质:仅"已取消"订单可清;函数内二次校验;仅 service_role 可执行(应用层已做 admin 门禁再调)。
--       事务内临时禁用 append-only 触发器删库存流水;任何异常 → 整事务回滚 → 触发器自动恢复(DDL 事务性)。
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_purge_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 只允许清除已取消订单,防误删活单
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = p_order_id AND lifecycle_status IN ('cancelled', '已取消')
  ) THEN
    RAISE EXCEPTION '仅已取消订单可彻底清除(order_id=%)', p_order_id;
  END IF;

  -- 事务内临时禁用 append-only 闸,删掉该单库存流水(异常则整事务回滚,DISABLE 一并回滚→触发器恢复)
  ALTER TABLE public.inventory_transactions DISABLE TRIGGER trg_invtxn_immutable;
  DELETE FROM public.inventory_transactions WHERE order_id = p_order_id;
  ALTER TABLE public.inventory_transactions ENABLE TRIGGER trg_invtxn_immutable;

  -- 预留账(可变,ON DELETE CASCADE 也会清,这里显式先清更稳)
  DELETE FROM public.inventory_reservation WHERE order_id = p_order_id;

  -- 删订单本体 → procurement_items / procurement_line_items / material_requirements /
  -- goods_receipts 等经 ON DELETE CASCADE 一并清除
  DELETE FROM public.orders WHERE id = p_order_id;
END;
$$;

-- 仅 service_role 可执行(应用层 DELETE /api/orders 已做 admin + 已取消 双校验后再调)
REVOKE ALL ON FUNCTION public.admin_purge_order(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_purge_order(uuid) TO service_role;

COMMENT ON FUNCTION public.admin_purge_order(uuid) IS
  '管理员彻底清除已取消订单(含 append-only 库存流水)。仅 service_role 可调;仅已取消单;测试数据清理用。';

-- ── 验证(手动)──
-- [1] 函数在:SELECT proname FROM pg_proc WHERE proname='admin_purge_order';  → 1 行
-- [2] 权限:SELECT has_function_privilege('service_role','admin_purge_order(uuid)','EXECUTE');  → true
-- [3] 拒活单:对一个非取消订单 SELECT admin_purge_order('<活单id>') → 报"仅已取消订单可彻底清除"
