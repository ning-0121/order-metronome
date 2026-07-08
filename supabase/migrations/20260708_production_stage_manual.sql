-- ========================================================================
-- 生产主管一次性进度初始化(2026-07-08)
-- ========================================================================
-- 生产中心的阶段档(待采购/物料在途/待排单/生产中/待发货)原本全靠里程碑+物料
-- 自动推算,老单数据不全时经常算错档。加一个一次性入口:生产主管登录后手动把
-- 每个在产订单归到正确的档,归好后管理员关闭入口。
--
-- 口径:手动档做「下限」——生效阶段 = max(手动档, 自动档)。主管设「生产中」后,
--   自动推算不会把它拉回「待采购」;但真实节点推进到更靠后(工厂完工)时自动接管。
--
-- 纯加法,不改任何现有列。⚠️ 由人手动在 Supabase SQL Editor 执行。

-- 1) orders 加手动档 + 审计(谁/何时设的)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS production_stage_manual text,
  ADD COLUMN IF NOT EXISTS production_stage_manual_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS production_stage_manual_at timestamptz;

COMMENT ON COLUMN public.orders.production_stage_manual IS
  '生产主管一次性手动档(下限):awaiting_procurement/materials_in_transit/ready_to_schedule/in_production/ready_to_ship/done。生效阶段取本列与自动推算中更靠后者。';

-- 合法值约束(允许 NULL = 未手动设过)
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_production_stage_manual_chk;
ALTER TABLE public.orders ADD CONSTRAINT orders_production_stage_manual_chk
  CHECK (production_stage_manual IS NULL OR production_stage_manual IN
    ('awaiting_procurement','materials_in_transit','ready_to_schedule','in_production','ready_to_ship','done'));

-- 2) 通用键值设置表(存一次性入口开关;以后其它开关也可复用)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.app_settings IS '全局设置键值表(service-role 写、登录用户读)。';

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
-- 登录用户可读;写只走 service-role(绕过 RLS),不给任何 insert/update 策略。
DROP POLICY IF EXISTS app_settings_read ON public.app_settings;
CREATE POLICY app_settings_read ON public.app_settings
  FOR SELECT TO authenticated USING (true);

-- 3) 播种:一次性入口默认开启
INSERT INTO public.app_settings (key, value)
VALUES ('production_stage_init', '{"open": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ========================================================================
-- 验证:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='orders' AND column_name LIKE 'production_stage_manual%';  -- 期望 3 行
--   SELECT * FROM public.app_settings WHERE key='production_stage_init';          -- 期望 open=true
-- 回滚:
--   ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_production_stage_manual_chk;
--   ALTER TABLE public.orders DROP COLUMN production_stage_manual, DROP COLUMN production_stage_manual_by, DROP COLUMN production_stage_manual_at;
--   DROP TABLE public.app_settings;
-- ========================================================================
