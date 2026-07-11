-- ========================================================================
-- 修 auto_create_exception_on_variance:%.1f 炸掉出货申请(2026-07-11)
-- ========================================================================
-- 根因:Postgres format() 只支持 %s/%I/%L,函数里 format('差异率：%.1f%%',...) 一执行就抛
--   `unrecognized format() type specifier "."` → AFTER INSERT trigger 报错回滚整个 INSERT
--   → 出货数量与订单差异 >5% 的申请一律提交失败(差异 ≤5% 不走该分支所以以前没炸)。
-- 修:① %.1f → round(...,1) + %s;② 开异常单包进 EXCEPTION 保护 —— 差异异常单是提醒,
--   它自己出任何错都不该挡出货申请(RAISE WARNING 留痕,不回滚业务写入)。
-- ⚠️ 人工在 Supabase(节拍器 scrtebexbxablybqpdla)执行。
-- ========================================================================

CREATE OR REPLACE FUNCTION auto_create_exception_on_variance() RETURNS trigger AS $$
DECLARE
  v_threshold numeric := 0.05;
  v_order_qty integer;
BEGIN
  SELECT quantity INTO v_order_qty FROM public.orders WHERE id = NEW.order_id;

  IF v_order_qty IS NOT NULL AND v_order_qty > 0 THEN
    IF ABS(NEW.shipment_qty - v_order_qty)::numeric / v_order_qty > v_threshold THEN
      BEGIN
        INSERT INTO public.exceptions (
          order_id, exception_type, severity, title, description,
          status, auto_generated, source_ref
        ) VALUES (
          NEW.order_id,
          'qty_variance',
          CASE WHEN ABS(NEW.shipment_qty - v_order_qty)::numeric / v_order_qty > 0.1 THEN 'high' ELSE 'medium' END,
          format('出货数量差异：订单%s件，实出%s件', v_order_qty, NEW.shipment_qty),
          format('差异率：%s%%，需要说明原因。', round(ABS(NEW.shipment_qty - v_order_qty)::numeric / v_order_qty * 100, 1)),
          'open',
          true,
          jsonb_build_object('shipment_confirmation_id', NEW.id, 'order_qty', v_order_qty, 'shipment_qty', NEW.shipment_qty)
        );
      EXCEPTION WHEN OTHERS THEN
        -- 差异异常单只是提醒,它失败不能挡出货申请
        RAISE WARNING 'auto_create_exception_on_variance skipped: %', SQLERRM;
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ========================================================================
-- 验证:
--   SELECT prosrc FROM pg_proc WHERE proname='auto_create_exception_on_variance';
--     -- 期望:含 round( 与 EXCEPTION WHEN OTHERS,不再含 '%.1f'
-- ========================================================================
