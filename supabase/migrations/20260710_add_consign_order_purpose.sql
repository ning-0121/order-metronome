-- ===== 20260710 order_purpose 扩展:新增 'consign'(委托加工/外发单)=====
-- 背景:委托加工/外发场景。绮陌照常出「生产单·原辅料单」交给工厂,料由工厂自采(不走采购核料),
--       其余保留(评审会/产前样/中查/尾查/CI报关/出运/收款)。里程碑模板 = 标准生产 V2 砍掉
--       'procurement_order_placed'(采购核料提交)一节点。详见 lib/milestoneTemplate.ts getApplicableMilestones。
--
-- 现约束:order_purpose IN ('inquiry','sample','production','trade')(见 20260619_add_trade_order_purpose.sql)
-- 目标:再并入 'consign'。
--
-- 约束名以生产实名为准(内联自动命名,通常 orders_order_purpose_check)。执行前可先查:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid='public.orders'::regclass AND pg_get_constraintdef(oid) ILIKE '%order_purpose%';

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_purpose_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_purpose_check
  CHECK (order_purpose IN ('inquiry', 'sample', 'production', 'trade', 'consign'));

-- 验证(应返回含 consign 的定义):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid='public.orders'::regclass AND conname='orders_order_purpose_check';
