-- ========================================================================
-- 收紧资金表 RLS(2026-07-10 五维度审计 P1-C)
-- ========================================================================
-- 问题:anon key 下发到浏览器,任何在职员工持自己合法 JWT 可直连 PostgREST
--   绕过 Server Action 的角色门禁,直写/直读资金表:
--   ① order_financials 的 INSERT/UPDATE 策略是 `auth.uid() IS NOT NULL`(全员可写)
--      → 可翻 allow_shipment/payment_hold 放货闸、伪造 deposit_received/balance_received、
--        覆盖 gross_profit。原迁移注释"action 层已把门"在公开 anon key 下不成立。
--   ② order_finance_events 的 SELECT 是 `USING(true)`(全员可读)→ 泄露所有订单的收/付款金额。
--
-- 修法:写/读收紧到「财务可见的办公/管理角色 OR 本单创建者·负责人」——与 order_financials
--   已有的 SELECT 策略同口径(见 20260703)。这样:
--     · 财务/管理(admin/finance/admin_assistant/sales_manager/order_manager)跨单读写(记款/审批/经营闸);
--     · 建单人/负责人写本单(建单初始化 initOrderFinancials、业务录售价);
--     · 生产/QC/物流/采购/非本单跟单 —— 一律挡在资金表外(即便持合法 JWT 直连 REST)。
--   服务端敏感写(recordPayment/finance-callback 等)本就走 service-role,绕过 RLS 不受影响。
-- 纯策略收紧,不改表结构、不动数据。⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

-- ── order_financials:INSERT / UPDATE 从"全员可写"收紧到"财务角色 OR 本单归属" ──
DROP POLICY IF EXISTS order_financials_insert ON public.order_financials;
CREATE POLICY order_financials_insert ON public.order_financials FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL AND (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
              AND (p.role IN ('admin','finance','admin_assistant','sales_manager','order_manager')
                   OR p.roles && ARRAY['admin','finance','admin_assistant','sales_manager','order_manager']::text[]))
      OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_financials.order_id
                 AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid()))
    )
  );

DROP POLICY IF EXISTS order_financials_update ON public.order_financials;
CREATE POLICY order_financials_update ON public.order_financials FOR UPDATE
  USING (
    auth.uid() IS NOT NULL AND (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
              AND (p.role IN ('admin','finance','admin_assistant','sales_manager','order_manager')
                   OR p.roles && ARRAY['admin','finance','admin_assistant','sales_manager','order_manager']::text[]))
      OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_financials.order_id
                 AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid()))
    )
  )
  WITH CHECK (
    auth.uid() IS NOT NULL AND (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
              AND (p.role IN ('admin','finance','admin_assistant','sales_manager','order_manager')
                   OR p.roles && ARRAY['admin','finance','admin_assistant','sales_manager','order_manager']::text[]))
      OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_financials.order_id
                 AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid()))
    )
  );

-- ── order_finance_events:SELECT 从"全员可读"收紧到"财务角色 OR 本单归属" ──
-- (写入本就无策略、走 service-role;order_id 可为 NULL,此时仅财务/管理可读)
DROP POLICY IF EXISTS ofe_select ON public.order_finance_events;
CREATE POLICY ofe_select ON public.order_finance_events FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
          AND (p.role IN ('admin','finance','admin_assistant','sales_manager','order_manager')
               OR p.roles && ARRAY['admin','finance','admin_assistant','sales_manager','order_manager']::text[]))
  OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_finance_events.order_id
             AND (o.created_by = auth.uid() OR o.owner_user_id = auth.uid()))
);

-- ========================================================================
-- 验证(期望各返回策略行):
--   SELECT policyname, cmd FROM pg_policies
--   WHERE tablename IN ('order_financials','order_finance_events')
--     AND policyname IN ('order_financials_insert','order_financials_update','ofe_select');
--   -- 期望 3 行,且 qual/with_check 不再是裸 auth.uid() IS NOT NULL / true。
-- 冒烟(强烈建议):用一个 production/qc 角色账号在前端建单/走出运,确认不报错;
--   建单初始化 order_financials 仍成功(建单人走归属分支)。
-- 回滚(恢复原宽松策略):
--   DROP POLICY IF EXISTS order_financials_insert ON public.order_financials;
--   CREATE POLICY order_financials_insert ON public.order_financials FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
--   DROP POLICY IF EXISTS order_financials_update ON public.order_financials;
--   CREATE POLICY order_financials_update ON public.order_financials FOR UPDATE USING (auth.uid() IS NOT NULL);
--   DROP POLICY IF EXISTS ofe_select ON public.order_finance_events;
--   CREATE POLICY ofe_select ON public.order_finance_events FOR SELECT TO authenticated USING (true);
-- ========================================================================
