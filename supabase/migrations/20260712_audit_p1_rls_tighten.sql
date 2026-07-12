-- ===== 2026-07-12 多维度审计 P1 修复:收紧 RLS(materials_bom + 供应商台账三表)=====
-- 背景:多张表 RLS 停在 auth.uid() IS NOT NULL 基线,任意登录用户可直连 PostgREST 绕过应用层。
--   P1-2 materials_bom:可改/删/读任意订单 BOM(标客供→静默少采购、篡改单耗破坏 MRP、直读预算成本)。
--   P1-1 supplier_fabric_ledger/payables/imports:含供应商底价/应付金额,却对全员 SELECT 敞开。
-- 复用现成 helper user_is_procurement_side(20260703)/ user_can_access_order(20260408);
--   新增 user_can_see_procurement_floor 对齐应用层 CAN_SEE_PROCUREMENT_FLOOR=[admin,finance,procurement,procurement_manager]。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行(scrtebexbxablybqpdla)。

-- ---------- 0) 底价可见判定(= 应用层 CAN_SEE_PROCUREMENT_FLOOR)----------
CREATE OR REPLACE FUNCTION public.user_can_see_procurement_floor(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = uid
      AND (
        role::text = ANY(ARRAY['admin','finance','procurement','procurement_manager'])
        OR (roles IS NOT NULL AND roles::text[] && ARRAY['admin','finance','procurement','procurement_manager'])
      )
  ), false);
$$;
GRANT EXECUTE ON FUNCTION public.user_can_see_procurement_floor(uuid) TO authenticated;

-- ---------- P1-2) materials_bom:采购侧直通 OR 可访问该订单(四策略)----------
-- 可重复执行:旧名(_auth)与新名都先 DROP,再建。
DROP POLICY IF EXISTS "bom_select_auth" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_insert_auth" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_update_auth" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_delete_auth" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_select" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_insert" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_update" ON public.materials_bom;
DROP POLICY IF EXISTS "bom_delete" ON public.materials_bom;

CREATE POLICY "bom_select" ON public.materials_bom FOR SELECT
USING (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));
CREATE POLICY "bom_insert" ON public.materials_bom FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));
CREATE POLICY "bom_update" ON public.materials_bom FOR UPDATE
USING (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));
CREATE POLICY "bom_delete" ON public.materials_bom FOR DELETE
USING (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));

-- ---------- P1-1) 供应商台账三表:SELECT 收紧到「可见底价」角色 ----------
-- (写入本就走 service-role + action 门禁;这里只收 SELECT。)
DROP POLICY IF EXISTS sfl_select ON public.supplier_fabric_ledger;
CREATE POLICY sfl_select ON public.supplier_fabric_ledger FOR SELECT
USING (public.user_can_see_procurement_floor(auth.uid()));

DROP POLICY IF EXISTS sli_select ON public.supplier_ledger_imports;
CREATE POLICY sli_select ON public.supplier_ledger_imports FOR SELECT
USING (public.user_can_see_procurement_floor(auth.uid()));

DROP POLICY IF EXISTS slp_select ON public.supplier_ledger_payables;
CREATE POLICY slp_select ON public.supplier_ledger_payables FOR SELECT
USING (public.user_can_see_procurement_floor(auth.uid()));

-- ---------- 验证(逐条跑,期望值见注释)----------
-- 1) helper 建成:SELECT proname FROM pg_proc WHERE proname='user_can_see_procurement_floor';  期望 1 行
-- 2) materials_bom 新策略:SELECT polname FROM pg_policies WHERE tablename='materials_bom' ORDER BY polname;
--    期望 bom_select/bom_insert/bom_update/bom_delete 四条,无 _auth 后缀
-- 3) 台账三表 SELECT 策略:SELECT tablename, polname, qual FROM pg_policies
--    WHERE tablename IN('supplier_fabric_ledger','supplier_ledger_imports','supplier_ledger_payables') AND cmd='SELECT';
--    期望 qual 含 user_can_see_procurement_floor
