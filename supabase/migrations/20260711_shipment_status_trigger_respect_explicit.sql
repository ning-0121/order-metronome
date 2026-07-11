-- ========================================================================
-- 修 shipment_confirmations 状态机 trigger:显式改 status 被静默改回(2026-07-11)
-- ========================================================================
-- 根因:trg_update_shipment_status(BEFORE UPDATE)每次都按 sign_id 推导 status
--   (sales_sign_id 非空 → 强制 'sales_signed')。而 撤回申请/财务驳回/财务系统批准回调
--   都只改 status 不动 sign_id → 状态被静默改回,update 报成功但没生效:
--   ① 撤回点了没反应 ② 驳回退不回业务 ③ 财务批准后回调放行也被打回。
-- 修:应用显式改了 status(NEW.status<>OLD.status)就尊重;没改才按签名推导(保住遗留签核流)。
-- ⚠️ 人工在 Supabase(节拍器 scrtebexbxablybqpdla)执行。
-- ========================================================================

CREATE OR REPLACE FUNCTION update_shipment_status() RETURNS trigger AS $$
BEGIN
  -- 应用显式变更 status(撤回/驳回/财务回调放行)→ 尊重,不推导
  IF NEW.status = OLD.status THEN
    IF NEW.sales_sign_id IS NOT NULL AND NEW.warehouse_sign_id IS NOT NULL AND NEW.finance_sign_id IS NOT NULL THEN
      NEW.status := 'fully_signed';
      NEW.locked_at := now();
    ELSIF NEW.sales_sign_id IS NOT NULL AND NEW.warehouse_sign_id IS NOT NULL THEN
      NEW.status := 'warehouse_signed';
    ELSIF NEW.sales_sign_id IS NOT NULL THEN
      NEW.status := 'sales_signed';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ========================================================================
-- 验证(改后跑):
--   UPDATE public.shipment_confirmations SET status='pending'
--     WHERE id='acb2b5b0-237b-4fb8-a58d-df2d3310604d' AND status='sales_signed';
--   SELECT status FROM public.shipment_confirmations
--     WHERE id='acb2b5b0-237b-4fb8-a58d-df2d3310604d';   -- 期望 'pending'
--   (验证完不用改回 —— 1022908 本来就要撤回重报)
-- 回滚:恢复旧函数体(去掉 IF NEW.status=OLD.status 包裹)。
-- ========================================================================
