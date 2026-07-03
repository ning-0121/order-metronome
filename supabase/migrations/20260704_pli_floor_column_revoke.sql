-- ========================================================================
-- 执行层 procurement_line_items 底价列级封锁(2026-07-04 审计 P0 残留)
-- ========================================================================
-- 问题:pli_select RLS = user_is_procurement_side(含 merchandiser!) OR
--   user_can_access_order。RLS 是行级、管不到列 → 跟单/订单创建者可浏览器
--   直连 `select unit_price from procurement_line_items` 读底价,绕过 action
--   层的 maskFloorForLines。跟单不在 CAN_SEE_PROCUREMENT_FLOOR → 违红线。
--
-- 修:列权限对 authenticated 统一生效(不分 app 角色),所以只能:
--   ① REVOKE 表级 SELECT;
--   ② GRANT 回"除价列外的所有列"(动态,免手列列名、对新列 fail-safe);
--   → 任何 authenticated 直连都读不到 unit_price/ordered_amount/difference_amount。
--   服务端需要底价的读(核料/对账/成本/PO/催单)改走 service_role 客户端
--   (service_role 有独立全权,不受本 REVOKE 影响),在 action 内按
--   CAN_SEE_PROCUREMENT_FLOOR 决定是否返回价 → floor 角色能力不变,直连堵死。
--
-- 敏感列(底价及其派生金额,业务/生产/跟单不可见):
--   unit_price(大货采购底价)、ordered_amount(=底价×量)、difference_amount(差异金额)
-- 保持可见:price_baseline(建议价,业务可见)、price_variance_pct(百分比,非绝对价)
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

-- ① 撤销表级 SELECT(否则列级 GRANT 不生效——表级权限会盖过列级)
REVOKE SELECT ON public.procurement_line_items FROM authenticated;

-- ② 动态授回"除敏感价列外的全部列"
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'procurement_line_items'
    AND column_name NOT IN ('unit_price', 'ordered_amount', 'difference_amount');
  EXECUTE format('GRANT SELECT (%s) ON public.procurement_line_items TO authenticated', cols);
END $$;

-- ========================================================================
-- 验证(执行后逐条跑):
-- ① 期望:authenticated 对三个价列无 SELECT 列权限(返回 0 行):
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_name='procurement_line_items' AND grantee='authenticated'
--     AND privilege_type='SELECT'
--     AND column_name IN ('unit_price','ordered_amount','difference_amount');
-- ② 期望:非价列有 SELECT 列权限(返回多行,含 material_name/ordered_qty 等):
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_name='procurement_line_items' AND grantee='authenticated'
--     AND privilege_type='SELECT' ORDER BY column_name;
-- ③ 真机验:用跟单账号(user session)直连
--   `select id, unit_price from procurement_line_items limit 1`
--   → 应报 permission denied for column unit_price(而非返回数据)。
--   同账号 `select id, material_name, ordered_qty ...`(不含价列)→ 仍正常。
--   采购/财务经 app 核料/成本页 → 仍能看到底价(走 service_role)。
-- ========================================================================
-- 回滚:GRANT SELECT ON public.procurement_line_items TO authenticated;
--   (恢复表级 SELECT;列级 GRANT 被表级覆盖,无害)
-- ========================================================================
