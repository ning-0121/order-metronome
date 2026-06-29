-- ========================================================================
-- QIMO OS O2 — Manufacturing Order(生产任务单)1:1 卫星表(定稿)
-- ========================================================================
-- Constitution:01 第3对象(非第4)/ 02 单一真相(只存"翻译字段",产品·数量·款色码·
--   原辅料·交期·客户包装要求 全部绑定不复制)/ 03 生命周期非复制 / 07 只表达需求(无工艺/
--   SMV/IE/MES/吊挂)/ 08 域职责。
-- 纯加法、幂等、不动 orders/order_line_items/materials_bom/采购/B1/旧 legacy 生成器。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行;Claude 不执行、未 push。
-- ========================================================================

-- ── 1) manufacturing_orders:每订单一份生产任务单(1:1)──
CREATE TABLE IF NOT EXISTS public.manufacturing_orders (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                      uuid NOT NULL UNIQUE                  -- 1:1 绑定 Customer Order
                                REFERENCES public.orders(id) ON DELETE CASCADE,
  mo_no                         text,                                 -- 生产任务单号(生成,如 MO-{order_no};唯一见下)

  -- ── 生命周期(Constitution 03)──
  status                        text NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','reviewing','confirmed','executing','closed')),

  -- ── MO 的"业务翻译给工厂执行"字段(新结构化,Constitution 02/04/07)──
  print_embroidery_requirements text,    -- 印绣要求
  qc_focus                      text,    -- QC 重点
  special_requirements          text,    -- 订单级特殊要求(区别于 materials_bom 的逐料 special_requirements)
  risk_notes                    text,    -- 风险提醒
  factory_packing_instructions  text,    -- 内部生产执行包装说明(≠ orders.packing_requirement 客户原始要求)
  factory_notes                 text,    -- 其他下厂说明(兜底)

  -- ── 内容确认留痕(confirmed = 内容已确认;呼应 Constitution 06:AI 结果须人工确认才进 MO)──
  confirmed_at                  timestamptz,
  confirmed_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- ── 正式下发工厂执行留痕(released_to_factory = 已下发生产部/工厂执行,与 confirmed 区分;对应 status→executing)──
  released_to_factory_at        timestamptz,
  released_to_factory_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  created_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- 生产任务单号唯一(仅当非空)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mo_no     ON public.manufacturing_orders(mo_no) WHERE mo_no IS NOT NULL;
-- 跨订单按状态筛选(未关闭)
CREATE INDEX        IF NOT EXISTS idx_mo_status ON public.manufacturing_orders(status) WHERE status <> 'closed';
-- order_id 已由 UNIQUE 自带索引,无需另建。

-- ── 2) RLS(登录可读/可建/可改;不开 DELETE,1:1 随订单 CASCADE)──
ALTER TABLE public.manufacturing_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mo_sel ON public.manufacturing_orders;
CREATE POLICY mo_sel ON public.manufacturing_orders FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mo_ins ON public.manufacturing_orders;
CREATE POLICY mo_ins ON public.manufacturing_orders FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS mo_upd ON public.manufacturing_orders;
CREATE POLICY mo_upd ON public.manufacturing_orders FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ── 3) updated_at 自动维护(可选;若项目已有通用 trigger 函数可复用,这里不强加)──
-- 说明:现有录入 action 都在写时显式 set updated_at=now(),与 materials_bom/material_master 一致,
--       故本表不加 trigger,保持与全库写法统一。

-- ========================================================================
-- 验证 SQL(执行后单独跑)
-- ========================================================================
-- 期望 1 行:表存在
-- SELECT table_name FROM information_schema.tables WHERE table_name='manufacturing_orders';
--
-- 期望 6 个业务字段 + status 都在:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='manufacturing_orders'
--    AND column_name IN ('status','print_embroidery_requirements','qc_focus','special_requirements',
--                        'risk_notes','factory_packing_instructions','factory_notes');  -- 期望 7 行
--
-- 期望 4 行:confirmed(内容确认)+ released_to_factory(下发执行)两组留痕字段都在
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='manufacturing_orders'
--    AND column_name IN ('confirmed_at','confirmed_by','released_to_factory_at','released_to_factory_by');
--
-- 期望:order_id 唯一约束存在(1:1)
-- SELECT conname, contype FROM pg_constraint
--  WHERE conrelid='public.manufacturing_orders'::regclass AND contype='u';
--
-- 期望:FK order_id → orders 存在
-- SELECT conname FROM pg_constraint
--  WHERE conrelid='public.manufacturing_orders'::regclass AND contype='f';
--
-- 期望 0 行(新表)
-- SELECT count(*) FROM manufacturing_orders;
--
-- 期望 rowsecurity = true
-- SELECT relrowsecurity FROM pg_class WHERE relname='manufacturing_orders';

-- ========================================================================
-- 回滚 SQL(纯加法,回滚干净)
-- ========================================================================
-- DROP TABLE IF EXISTS public.manufacturing_orders;
