-- ========================================================================
-- material_supplier 大货底价列级封锁(2026-07-05 审计 P0-1 防御纵深收尾)
-- ========================================================================
-- 问题:material_supplier.unit_price = 大货采购底价(仅 CAN_SEE_PROCUREMENT_FLOOR =
--   admin/finance/采购 可见)。app 层 listMaterialSuppliers 已按角色剥价,但底价列
--   在 DB 层对 authenticated 仍可 SELECT → 懂技术的用户可用 anon key 直连
--   `select unit_price from material_supplier`,绕过 action 层的剥价 → 违红线。
--   (与 20260704_pli_floor_column_revoke.sql 同源问题:RLS 是行级、管不到列。)
--
-- 修:列权限对 authenticated 统一生效(不分 app 角色),所以只能:
--   ① REVOKE 表级 SELECT;
--   ② GRANT 回"除底价列外的所有列"(动态,免手列列名、对新列 fail-safe);
--   → 任何 authenticated 直连都读不到 unit_price。
--   服务端需要底价的读(sourcing 打分 / 供应商报价列表)已改走 service_role 客户端
--   (service_role 有独立全权,不受本 REVOKE 影响),在 action 内按
--   CAN_SEE_PROCUREMENT_FLOOR 决定是否返回价 → floor 角色能力不变,直连堵死。
--   已转 service-role 的读:
--     · app/actions/procurement-kernel.ts getOrderProcurementKernel(sourcing 打分)
--     · app/actions/material-master.ts listMaterialSuppliers(供应商报价列表)
--   写口(upsert/update is_preferred/delete,均不 .select())不受 SELECT REVOKE 影响,
--   与 pli 迁移同款安全(参照 procurement.ts 的 user-session insert 早已在 pli REVOKE 下运行)。
--
-- 敏感列(大货底价,业务/生产/QC/跟单不可见):
--   unit_price(供应商大货报价底价)
-- 保持可见:currency/lead_days/moq/purchase_unit/is_preferred/last_quoted_at/note 等
-- ⚠️ 由人手动在 Supabase SQL Editor 执行。

-- ① 撤销表级 SELECT(否则列级 GRANT 不生效——表级权限会盖过列级)
REVOKE SELECT ON public.material_supplier FROM authenticated;

-- ② 动态授回"除底价列外的全部列"
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'material_supplier'
    AND column_name NOT IN ('unit_price');
  EXECUTE format('GRANT SELECT (%s) ON public.material_supplier TO authenticated', cols);
END $$;

-- ========================================================================
-- 验证(执行后逐条跑):
-- ① 期望:authenticated 对 unit_price 无 SELECT 列权限(返回 0 行):
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_name='material_supplier' AND grantee='authenticated'
--     AND privilege_type='SELECT' AND column_name='unit_price';
-- ② 期望:非价列有 SELECT 列权限(返回多行,含 supplier_id/lead_days/moq 等):
--   SELECT column_name FROM information_schema.column_privileges
--   WHERE table_name='material_supplier' AND grantee='authenticated'
--     AND privilege_type='SELECT' ORDER BY column_name;
-- ③ 真机验:用非采购账号(如生产/QC user session)直连
--   `select id, unit_price from material_supplier limit 1`
--   → 应报 permission denied for column unit_price(而非返回数据)。
--   同账号 `select id, supplier_id, lead_days ...`(不含价列)→ 仍正常。
--   采购/财务经 app 物料主数据供应商页 / 采购内核 sourcing → 仍能看到底价(走 service_role)。
-- ========================================================================
-- 回滚:GRANT SELECT ON public.material_supplier TO authenticated;
--   (恢复表级 SELECT;列级 GRANT 被表级覆盖,无害)
-- ========================================================================
