-- ========================================================================
-- DELETE 策略补齐 + 翻倍明细清理(2026-07-03 事故修复)
-- ========================================================================
-- 事故:order_line_items 只有 SELECT/INSERT/UPDATE 策略,没有 DELETE 策略。
--   保存明细 = 先删后插;RLS 把删除静默拦成 0 行(PostgREST 不报错!),
--   插入照常 → 每次保存明细翻一倍(用户实测 4 次保存 → 7500 件显示 30000 件)。
-- 同型地雷一并补:material_requirements(重新提交采购会叠需求)、
--   procurement_items(草稿孤儿清理一直空转)、purchase_orders(删草稿单)。
-- 代码侧已加保险丝:删除删了 0 行即中止报错,永不叠加(先于本迁移已部署)。
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。
-- ========================================================================

-- ── ① 补 DELETE 策略(权限收敛在 server action 层,与各表既有策略同口径)──
DROP POLICY IF EXISTS oli_delete_auth ON public.order_line_items;
CREATE POLICY oli_delete_auth ON public.order_line_items FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS mr_del ON public.material_requirements;
CREATE POLICY mr_del ON public.material_requirements FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS pi_del ON public.procurement_items;
CREATE POLICY pi_del ON public.procurement_items FOR DELETE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS po_del ON public.purchase_orders;
CREATE POLICY po_del ON public.purchase_orders FOR DELETE USING (auth.uid() IS NOT NULL);

-- ── ② 清理已翻倍的明细(完全同 订单+款+品名+双色名+尺码配比 的重复行,留最早一条)──
-- 合法业务不会出现两行完全相同的 款+色+尺码配比;重复 = 本次事故的叠加产物。
DELETE FROM public.order_line_items t
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY order_id, coalesce(style_no,''), coalesce(product_name,''),
                        coalesce(color_cn,''), coalesce(color_en,''), sizes::text
           ORDER BY line_no NULLS LAST, created_at, id
         ) AS rn
  FROM public.order_line_items
) d
WHERE t.id = d.id AND d.rn > 1;

-- ========================================================================
-- 验证(执行后逐条跑,期望值见注释)
-- ========================================================================
-- ① 期望 4 行(四个 DELETE 策略都在):
-- SELECT polname FROM pg_policy
--  WHERE polname IN ('oli_delete_auth','mr_del','pi_del','po_del');
-- ② 期望 0 行(明细无完全重复):
-- SELECT order_id, style_no, color_cn, sizes::text, count(*)
--   FROM public.order_line_items
--  GROUP BY 1,2,3,4 HAVING count(*) > 1;
-- ③ 抽查年年旺单(期望 4 行/7500 件,不再是 16 行/30000):
-- SELECT count(*) AS 行数, sum(qty_pcs) AS 总件数 FROM public.order_line_items
--  WHERE order_id = (SELECT id FROM public.orders WHERE order_no='QM-20260703-030');

-- ========================================================================
-- ④ 全库体检(信息,把剩余盲区照出来):RLS 开启、代码可能删、却没 DELETE 策略的表
--    跑完把结果发给 Claude,针对性再补(别盲目全开)。
-- ========================================================================
-- SELECT c.relname AS 表, string_agg(DISTINCT p.polcmd::text, ',') AS 已有策略动作
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
--   LEFT JOIN pg_policy p ON p.polrelid = c.oid
--  WHERE c.relkind='r' AND c.relrowsecurity
--  GROUP BY c.relname
-- HAVING string_agg(DISTINCT p.polcmd::text, ',') NOT LIKE '%d%'
--    AND string_agg(DISTINCT p.polcmd::text, ',') NOT LIKE '%*%'
--  ORDER BY 1;

-- ========================================================================
-- 回滚
-- ========================================================================
-- DROP POLICY IF EXISTS oli_delete_auth ON public.order_line_items;
-- DROP POLICY IF EXISTS mr_del ON public.material_requirements;
-- DROP POLICY IF EXISTS pi_del ON public.procurement_items;
-- DROP POLICY IF EXISTS po_del ON public.purchase_orders;
-- (②清理不回滚:删的是事故叠加行;若误删可从 po_parse_snapshot 冻结底档重录)
