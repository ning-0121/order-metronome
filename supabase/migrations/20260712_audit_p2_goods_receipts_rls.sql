-- ===== 2026-07-12 多维度审计 P2-1:收紧 goods_receipts RLS(原三策略均 auth-only)=====
-- 问题:gr_select/insert/update_auth 全是 auth.uid() IS NOT NULL → 任意登录用户可直连 PostgREST
--   插入虚高 received_qty 的 pass 记录、或篡改 inspection_result/return_status,绕过 recordGoodsReceipt
--   的 checkOperator(仅采购/admin),污染对账与库存派生流水。
-- 修:三策略改为「采购侧直通 OR 可访问该订单」——复用现成 helper(与 P1-2/materials_bom 同口径)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行(scrtebexbxablybqpdla)。可重复执行(先 DROP 新旧名)。

DROP POLICY IF EXISTS "gr_select_auth" ON public.goods_receipts;
DROP POLICY IF EXISTS "gr_insert_auth" ON public.goods_receipts;
DROP POLICY IF EXISTS "gr_update_auth" ON public.goods_receipts;
DROP POLICY IF EXISTS "gr_select" ON public.goods_receipts;
DROP POLICY IF EXISTS "gr_insert" ON public.goods_receipts;
DROP POLICY IF EXISTS "gr_update" ON public.goods_receipts;

CREATE POLICY "gr_select" ON public.goods_receipts FOR SELECT
USING (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));
CREATE POLICY "gr_insert" ON public.goods_receipts FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));
CREATE POLICY "gr_update" ON public.goods_receipts FOR UPDATE
USING (auth.uid() IS NOT NULL
  AND (public.user_is_procurement_side(auth.uid()) OR public.user_can_access_order(auth.uid(), order_id)));

-- 验证:
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='goods_receipts' ORDER BY policyname;
--   期望 gr_insert/gr_select/gr_update 三条,无 _auth 后缀
