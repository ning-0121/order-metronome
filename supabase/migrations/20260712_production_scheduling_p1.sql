-- ============================================================
-- 生产排单 P1:工厂能力 + 订单排产要求 + 派工表
-- Supabase: scrtebexbxablybqpdla（QIMO / 节拍器）
-- Date: 2026-07-12
-- ------------------------------------------------------------
-- 生产主管在生产中心「待排单」桶把款(个别到色)派给工厂,依据:擅长品类/品质/织造/能否包装/
--   能接的订单类型 + 剩余产能(月产能−在线量) + 准时率 + 在做进度 + 原辅料到位(读采购进度)。
-- 纯加法:工厂/订单加列 + 新派工表。P2 再上按时段产能账,P1 用静态月产能。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ============================================================

-- 1) 工厂能力(工厂管理页可编辑;已有 product_categories 擅长品类 / monthly_capacity 月产能)
ALTER TABLE public.factories
  ADD COLUMN IF NOT EXISTS quality_grades     text[],   -- 擅长品质:高/中/跑量
  ADD COLUMN IF NOT EXISTS weave_types        text[],   -- 织造:针织/梭织(两者都填=都能做)
  ADD COLUMN IF NOT EXISTS can_package        boolean,  -- 能否包装
  ADD COLUMN IF NOT EXISTS order_capabilities text[];   -- 能接的订单类型:清加工/经销单/委托加工

-- 2) 订单排产要求(业务/主管手填;品类从产品款、订单类型从 order_purpose 派生)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS quality_grade text,           -- 高/中/跑量
  ADD COLUMN IF NOT EXISTS weave_type    text,           -- 针织/梭织
  ADD COLUMN IF NOT EXISTS needs_package boolean;        -- 是否要包装

-- 3) 派工表(核心):一行=一款(color 空)或一款一色(color 有值)→ 一个工厂 + 排产窗口
CREATE TABLE IF NOT EXISTS public.production_dispatch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  style_no      text,                                    -- 款号(空=整单单款单)
  color         text,                                    -- 空=整款;有值=单色派工
  factory_id    uuid REFERENCES public.factories(id),
  factory_name  text,
  planned_qty   integer,                                 -- 该派工件数
  planned_start date,
  planned_end   date,
  status        text NOT NULL DEFAULT 'scheduled'        -- scheduled 已排 / in_production 生产中 / done 完成 / cancelled
                CHECK (status IN ('scheduled','in_production','done','cancelled')),
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prod_dispatch_order   ON public.production_dispatch(order_id);
CREATE INDEX IF NOT EXISTS idx_prod_dispatch_factory ON public.production_dispatch(factory_id, status);

ALTER TABLE public.production_dispatch ENABLE ROW LEVEL SECURITY;
-- 读:登录即可(排产是协作信息,不含价);写走 service-role(action 里已按角色 CAN_EDIT_MO/生产主管把关)
DROP POLICY IF EXISTS "prod_dispatch_select" ON public.production_dispatch;
CREATE POLICY "prod_dispatch_select" ON public.production_dispatch FOR SELECT USING (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.production_dispatch IS '生产派工:款(或色)→工厂+排产窗口。生产主管排单;P1 静态月产能,P2 接按时段产能账';

-- 验证(期望:factories 4 新列 / orders 3 新列 / production_dispatch 表存在)
-- SELECT column_name FROM information_schema.columns WHERE table_name='factories' AND column_name IN ('quality_grades','weave_types','can_package','order_capabilities');
-- SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name IN ('quality_grade','weave_type','needs_package');
-- SELECT to_regclass('public.production_dispatch');
-- 回滚:DROP TABLE public.production_dispatch; ALTER TABLE public.factories DROP COLUMN ...; ALTER TABLE public.orders DROP COLUMN ...;
